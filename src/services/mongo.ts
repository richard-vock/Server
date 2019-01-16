/**
 * Imported external configuration
 * MongoClient is the main way to connect to a MongoDB server
 * ObjectId is the type & constructor of a MongoDB unique identifier
 */
import { MongoClient, ObjectId } from 'mongodb';
import { Configuration } from './configuration';

/**
 * Imported for detailed logging
 */
import { Verbose, RootDirectory } from '../environment';
import { inspect as InspectObject } from 'util';

import * as base64img from 'base64-img';
import * as PNGtoJPEG from 'png-to-jpeg';
import { readFile, writeFileSync, readFileSync } from 'fs';

/** Interfaces */
import { Compilation } from '../interfaces/compilation.interface';
import { Model } from '../interfaces/model.interface';

/**
 * Object containing variables which define an established connection
 * to a MongoDB Server specified in Configuration
 * @type {Object}
 */
const Mongo = {
  Client: undefined,
  Connection: undefined,
  DBObjectsRepository: undefined,
  AccountsRepository: undefined,
  /**
   * Initialize a MongoDB Client
   * uses hostname and port defined in Configuration file
   * Make sure our predefined collections exist in the Database
   * Save the most used Database as a variable
   * to reduce the amount of calls needed
   */
  init: async () => {
    this.Client = new MongoClient(`mongodb://${Configuration.Mongo.Hostname}:${Configuration.Mongo.Port}/`, {
      useNewUrlParser: true,
      reconnectTries: Number.POSITIVE_INFINITY,
      reconnectInterval: 1000,
    });
    this.Connection = await this.Client.connect();
    this.DBObjectsRepository = await this.Client.db(Configuration.Mongo.Databases.ObjectsRepository.Name);
    this.AccountsRepository = await this.Client.db(Configuration.Mongo.Databases.Accounts.Name);
    Configuration.Mongo.Databases.ObjectsRepository.Collections.forEach(collection => {
      this.DBObjectsRepository.createCollection(collection.toLowerCase());
    });
  },
  /**
   * Checks if MongoDB is still connected
   * used as Middleware
   */
  isMongoDBConnected: async (request, response, next) => {
    const isConnected = await this.Client.isConnected();
    if (isConnected) {
      next();
    } else {
      console.warn('Incoming request while not connected to MongoDB');
      response.send({ message: 'Cannot connect to Database. Contact sysadmin' });
    }
  },
  /**
   * Fix cases where an ObjectId is sent but it is not detected as one
   * used as Middleware
   */
  fixObjectId: async (request, response, next) => {
    if (request && request.body && request.body['_id']) {
      if (ObjectId.isValid(request.body['_id'])) {
        request.body['_id'] = ObjectId(request.body['_id']);
      }
    }
    next();
  },
  /**
   * Adds a new LDAP user or updates LDAP user sessionID
   */
  addToAccounts: async (request, response) => {
    const user = request.user;
    const username = request.body.username;
    const sessionID = request.sessionID;
    const ldap = this.AccountsRepository.collection('ldap');
    const found = await ldap.find({ username: username }).toArray();
    switch (found.length) {
      // TODO: Pack this into config somehow...
      case 0:
        // No Account with this LDAP username
        // Create new
        ldap.insertOne(
          {
            username: username,
            sessionID: sessionID,
            fullname: user['cn'],
            prename: user['givenName'],
            surname: user['sn'],
            status: user['UniColognePersonStatus'],
            mail: user['mail'],
            data: { compilations: [], annotations: [], models: [] }
          }, (ins_err, ins_res) => {
            if (ins_err) {
              response.send({ status: 'error' });
              console.error(ins_res);
            } else {
              console.log(ins_res.ops);
              response.send({ status: 'ok', data: ins_res.ops[0].data });
            }
          });
        break;
      case 1:
        // Account found
        // Update session ID
        ldap.updateOne({ username: username },
          {
            $set:
            {
              sessionID: sessionID,
              fullname: user['cn'],
              prename: user['givenName'],
              surname: user['sn'],
              status: user['UniColognePersonStatus'],
              mail: user['mail']
            }
          }, (up_err, up_res) => {
            if (up_err) {
              response.send({ status: 'error' });
              console.error(up_err);
            } else {
              ldap.findOne({ sessionID: sessionID, username: username }, (f_err, f_res) => {
                if (f_err) {
                  response.send({ status: 'error' });
                  console.error(f_err);
                } else {
                  response.send({ status: 'ok', data: f_res.data });
                }
              });
            }
          });
        break;
      default:
        // Too many Accountst
        console.error('Multiple Accounts found for LDAP username ' + username);
        response.send({ status: 'error' });
        break;
    }
  },
  /**
   * Get ObjectRepository data for current user
   */
  getLinkedData: async (request, response) => {
    const sessionID = request.sessionID;
    const ldap = this.AccountsRepository.collection('ldap');
    const found = await ldap.findOne({ sessionID: sessionID });
    if (!found || !found.data) {
      response.send({ status: 'ok' });
      return;
    }
    found.data.compilations = await Promise.all(found.data.compilations
      .map(async compilation => await Mongo.resolve(compilation, 'compilation')));
    found.data.models = await Promise.all(found.data.models
      .map(async model => await Mongo.resolve(model, 'model')));
    found.data.annotations = await Promise.all(found.data.annotations
      .map(async annotation => await Mongo.resolve(annotation, 'annotation')));
    response.send({ status: 'ok', data: found.data });
  },
  /**
   * Gets LDAP user to confirm validity of sessionID
   */
  checkAccount: async (request, response, next) => {
    const sessionID = request.sessionID = (request.cookies['connect.sid']) ?
      request.cookies['connect.sid'].substr(2, 36) : request.sessionID;
    const ldap = this.AccountsRepository.collection('ldap');
    const found = await ldap.find({ sessionID: sessionID }).toArray();
    switch (found.length) {
      case 0:
        // Invalid sessionID
        response.send({ message: 'Invalid session' });
        break;
      case 1:
        // Valid sessionID
        next();
        break;
      default:
        // Multiple sessionID. Invalidate all
        ldap.updateMany({ sessionID: sessionID }, { $set: { sessionID: null } }, (up_err, up_res) => {
          console.log('Invalidated multiple sessionIDs due to being the same');
          response.send({ message: 'Invalid session' });
        });
        break;
    }
  },
  /**
   * When the user submits the metadataform this function
   * adds the missing data to defined collections
   */
  submit: async (request, response) => {
    if (Verbose) {
      console.log('VERBOSE: Handling submit request');
      console.log(InspectObject(request.body));
    }

    const collection = this.DBObjectsRepository.collection('digitalobject');
    const resultObject = { ...request.body };

    /**
     * Handle re-submit for changing a finished DigitalObject
     */
    if (resultObject['_id']) {
      console.log(`Re-submitting DigitalObject ${resultObject['_id']}`);
      collection.deleteOne({ _id: resultObject['_id'] });
    } else {
      resultObject['_id'] = ObjectId();
      console.log(`Generated DigitalObject ID ${resultObject['_id']}`);
    }

    /**
     * Adds data {field} to a collection {collection}
     * and returns the {_id} of the created object.
     * If {field} already has an {_id} property the server
     * will assume the object already exists in the collection
     * and instead return the existing {_id}
     */
    const addAndGetId = async (field, add_to_coll) => {
      switch (add_to_coll) {
        case 'person':
          // Add new roles to person
          field['roles'] = [{
            role: field['person_role'],
            relatedDigitalObject: resultObject['_id']
          }];
          if (field['_id'] !== undefined && field['_id'].length > 0) {
            console.log(`Adding role ${field['person_role']} to person ${field['_id']}`);
          }
          return {
            '_id': (field['_id'] !== undefined && field['_id'].length > 0) ?
              await this.DBObjectsRepository.collection(add_to_coll)
                .updateOne({ _id: ObjectId(field['_id']) }, { $push: { roles: { $each: field['roles'] } } }).then(result => {
                  return String(field['_id']);
                }) :
              await this.DBObjectsRepository.collection(add_to_coll).insertOne(field).then(result => {
                return String(result.ops[0]['_id']);
              })
          };
          break;
        case 'institution':
          // Add new roles to institution
          field['roles'] = [{
            role: field['institution_role'],
            relatedDigitalObject: resultObject['_id']
          }];
          if (field['_id'] !== undefined && field['_id'].length > 0) {
            console.log(`Adding role ${field['institution_role']} to institution ${field['_id']}`);
          }
          return {
            '_id': (field['_id'] !== undefined && field['_id'].length > 0) ?
              await this.DBObjectsRepository.collection(add_to_coll)
                .updateOne({ _id: ObjectId(field['_id']) }, { $push: { roles: { $each: field['roles'] } } }).then(result => {
                  return String(field['_id']);
                }) :
              await this.DBObjectsRepository.collection(add_to_coll).insertOne(field).then(result => {
                return String(result.ops[0]['_id']);
              })
          };
          break;
        default:
          return {
            '_id': (field['_id'] !== undefined && field['_id'].length > 0) ?
              String(field['_id']) :
              await this.DBObjectsRepository.collection(add_to_coll).insertOne(field).then(result => {
                return String(result.ops[0]['_id']);
              })
          };
          break;
      }
    };

    /**
     * Use addAndGetId function on all Arrays containing
     * data that need to be added to collections
     */

    // TODO: Eleganter lösen
    resultObject['digobj_rightsowner_person'] = await Promise.all(
      resultObject['digobj_rightsowner_person'].map(async person => {
        if (person['person_institution'] === 'add_new_institution') {
          const institution = person['person_institution_data'].pop();
          const newInst = await addAndGetId(institution, 'institution');
          person['person_institution_data'][0] = newInst;
        }
        return addAndGetId(person, 'person');
      }));

    resultObject['digobj_rightsowner_institution'] = await Promise.all(
      resultObject['digobj_rightsowner_institution'].map(async institution => addAndGetId(institution, 'institution')));

    if (ObjectId.isValid(resultObject['digobj_rightsowner'])) {
      const newRightsOwner = {};
      newRightsOwner['_id'] = resultObject['digobj_rightsowner'];
      if (resultObject['digobj_rightsownerSelector'] === '1' || parseInt(resultObject['digobj_rightsownerSelector'], 10) === 1) {
        newRightsOwner['person_role'] = 'RIGHTS_OWNER';
        resultObject['digobj_rightsowner_person'][0] = await addAndGetId(newRightsOwner, 'person');
      } else if (resultObject['digobj_rightsownerSelector'] === '2' || parseInt(resultObject['digobj_rightsownerSelector'], 10) === 2) {
        newRightsOwner['institution_role'] = 'RIGHTS_OWNER';
        resultObject['digobj_rightsowner_institution'][0] = await addAndGetId(newRightsOwner, 'institution');
      }
    }

    resultObject['contact_person'] = await Promise.all(
      resultObject['contact_person'].map(async person => addAndGetId(person, 'person')));

    if (resultObject['contact_person_existing'] instanceof Array && resultObject['contact_person_existing'].length > 0) {
      if (resultObject['contact_person_existing'][0] === 'add_to_new_rightsowner_person') {
        // Contact Person is the same as Rightsowner Person
        const newContact = { ...resultObject['digobj_rightsowner_person'][0] };
        newContact['person_role'] = 'CONTACT_PERSON';
        if (resultObject['contact_person'] instanceof Array) {
          resultObject['contact_person'].push(await addAndGetId(newContact, 'person'));
        } else {
          addAndGetId(newContact, 'person');
        }
      } else if (ObjectId.isValid(resultObject['contact_person_existing'][0])) {
        // Contact Person is existing Person
        const newContact = {};
        newContact['person_role'] = 'CONTACT_PERSON';
        newContact['_id'] = resultObject['contact_person_existing'][0];
        if (resultObject['contact_person'] instanceof Array) {
          resultObject['contact_person'].push(await addAndGetId(newContact, 'person'));
        } else {
          addAndGetId(newContact, 'person');
        }
      }
    }

    resultObject['digobj_person'] = await Promise.all(
      resultObject['digobj_person'].map(async person => {
        if (person['person_institution'] === 'add_new_institution') {
          const institution = person['person_institution_data'].pop();
          const newInst = await addAndGetId(institution, 'institution');
          person['person_institution_data'][0] = newInst;
        }
        return addAndGetId(person, 'person');
      }));

    resultObject['phyObjs'] = await Promise.all(
      resultObject['phyObjs'].map(async phyObj => {
        if (ObjectId.isValid(phyObj['phyobj_rightsowner'])) {
          const newPhyRightsOwnerPerson = {};
          newPhyRightsOwnerPerson['_id'] = phyObj['phyobj_rightsowner'];
          newPhyRightsOwnerPerson['person_role'] = 'RIGHTS_OWNER';
          phyObj['phyobj_rightsowner_person'] = await addAndGetId(newPhyRightsOwnerPerson, 'person');
        } else if (phyObj['phyobj_rightsowner_person'].length > 0 && !phyObj['phyobj_rightsowner_person'][0]['_id']) {
          phyObj['phyobj_rightsowner_person'] = await Promise.all(
            phyObj['phyobj_rightsowner_person'].map(
              phyObjRightsOwner => addAndGetId(phyObjRightsOwner, 'person')
            ));
        }

        if (phyObj['phyobj_person_existing'] instanceof Array && phyObj['phyobj_person_existing'].length > 0) {
          if (phyObj['phyobj_person_existing'][0] === 'add_to_new_rightsowner_person') {
            // Contact Person is the same as Rightsowner Person
            const newContact = { ...phyObj['phyobj_rightsowner_person'][0] };
            newContact['person_role'] = 'CONTACT_PERSON';
            if (phyObj['phyobj_person'] instanceof Array) {
              phyObj['phyobj_person'].push(await addAndGetId(newContact, 'person'));
            } else {
              addAndGetId(newContact, 'person');
            }
          } else if (ObjectId.isValid(phyObj['phyobj_person_existing'][0])) {
            // Contact Person is existing Person
            const newContact = {};
            newContact['person_role'] = 'CONTACT_PERSON';
            newContact['_id'] = phyObj['phyobj_person_existing'][0];
            if (phyObj['phyobj_person'] instanceof Array) {
              phyObj['phyobj_person'].push(await addAndGetId(newContact, 'person'));
            } else {
              addAndGetId(newContact, 'person');
            }
          }
        }

        if (phyObj['phyobj_rightsowner_institution'].length > 0 && !phyObj['phyobj_rightsowner_institution'][0]['_id']) {
          phyObj['phyobj_rightsowner_institution'] = await Promise.all(
            phyObj['phyobj_rightsowner_institution'].map(
              phyObjRightsOwner => addAndGetId(phyObjRightsOwner, 'institution')
            ));
        }
        if (phyObj['phyobj_person'] && !phyObj['phyobj_person']['_id']) {
          phyObj['phyobj_person'] = await Promise.all(
            phyObj['phyobj_person'].map(
              async (phyObjPerson) => {
                if (phyObjPerson['person_institution'] === 'add_new_institution') {
                  const institution = phyObjPerson['person_institution_data'].pop();
                  const newInst = await addAndGetId(institution, 'institution');
                  phyObjPerson['person_institution_data'][0] = newInst;
                }
                return addAndGetId(phyObjPerson, 'person');
              }));
        }
        if (phyObj['phyobj_institution'] && !phyObj['phyobj_institution']['_id']) {
          phyObj['phyobj_institution'] = await Promise.all(
            phyObj['phyobj_institution'].map(
              phyObjInstitution => addAndGetId(phyObjInstitution, 'institution')
            ));
        }
        return addAndGetId(phyObj, 'physicalobject');
      }));

    if (resultObject['digobj_tags'] && resultObject['digobj_tags'].length > 0) {
      resultObject['digobj_tags'] = await Promise.all(
        resultObject['digobj_tags'].map(async tag => addAndGetId(tag, 'tag')));
    }

    console.log(resultObject);

    collection.insertOne(resultObject, (db_error, db_result) => {
      if (db_error) {
        console.error(db_error);
        response.send('Failed to add');
      }
      if (Verbose) {
        console.log(`VERBOSE: Finished Object ${db_result.ops[0]['_id']}`);
      }
      response.send(db_result.ops[0]);
    });
  },
  /**
   * Express HTTP POST request
   * Handles a single document that needs to be added
   * to our Database
   * request.body is any JavaScript Object
   * On success, sends a response containing the added Object
   */
  addToObjectCollection: async (request, response) => {
    const RequestCollection = request.params.collection.toLowerCase();

    if (Verbose) {
      console.log('VERBOSE: Adding to the following collection ' + RequestCollection);
    }

    const collection = this.DBObjectsRepository.collection(RequestCollection);
    const sessionID = request.sessionID;
    const ldap = this.AccountsRepository.collection('ldap');

    const addAndGetId = async (field, add_to_coll) => {
      return {
        '_id': (field['_id'] !== undefined && field['_id'].length > 0) ?
          String(field['_id']) :
          await this.DBObjectsRepository.collection(add_to_coll).insertOne(field).then(result => {
            return String(result.ops[0]['_id']);
          })
      };
    };

    switch (RequestCollection) {
      case 'compilation':
        const resultObject = request.body;

        if (resultObject['_id']) {
          const OldModels = [];
          let NewModels = [];

          // Sort which models need to be added
          resultObject['models'].forEach(model => {
            if (model['_id']) {
              OldModels.push(model);
            } else {
              NewModels.push(model);
            }
          });

          NewModels = await Promise.all(
            NewModels.map(async model => addAndGetId(model, 'model')));

          resultObject['models'] = OldModels.concat(NewModels);

          // Update compilation instance
          const found = await collection.findOne({ _id: resultObject['_id'] });
          collection.updateOne({ _id: resultObject['_id'] }, { $set: resultObject }, (up_error, up_result) => {
            if (up_error) {
              console.error('Failed to update compilation instance');
              response.send(404);
            } else {
              console.log(`Updated ${resultObject['_id']}`);
              response.send({ status: 'ok' });
            }
          });
        } else {
          // Add new compilation
          collection.insertOne(resultObject, async (db_error, db_result) => {
            const userData = await ldap.findOne({ sessionID: sessionID });
            userData.data.compilations.push(`${db_result.ops[0]['_id']}`);
            const result = await ldap.updateOne({ sessionID: sessionID }, { $set: { data: userData.data } });
            if (result.result.ok === 1) {
              response.send({ status: 'ok' });
            } else {
              response.send({ status: 'error' });
            }
            if (Verbose) {
              console.log(`VERBOSE: Success! Added new compilation ${db_result.ops[0]['_id']}`);
            }
          });
        }
        break;
      case 'model':
      case 'annotation':
        collection.insertOne(request.body, async (db_error, db_result) => {
          const userData = await ldap.findOne({ sessionID: sessionID });
          if (RequestCollection === 'model') {
            userData.data.models.push(`${db_result.ops[0]['_id']}`);
          } else if (RequestCollection === 'annotation') {
            userData.data.annotations.push(`${db_result.ops[0]['_id']}`);
          }
          const result = await ldap.updateOne({ sessionID: sessionID }, { $set: { data: userData.data } });
          if (result.result.ok === 1) {
            response.send(db_result.ops);
          } else {
            response.send({ status: 'error' });
          }
          if (Verbose) {
            console.log(`VERBOSE: Success! Added new ${RequestCollection} ${db_result.ops[0]['_id']}`);
          }
        });
        break;
      default:
        collection.insertOne(request.body, (db_error, result) => {
          response.send(result.ops);

          if (Verbose) {
            if (result.ops[0] && result.ops[0]['_id']) {
              console.log(`VERBOSE: Success! Added to ${RequestCollection} with ID ${result.ops[0]['_id']}`);
            }
          }
        });
        break;
    }
  },
  /**
   * Express HTTP POST request
   * Finds a model by it's ObjectId and
   * updates it's preview screenshot
   */
  updateScreenshot: async (request, response) => {
    const imagedata = request.body.data;
    if (Verbose) {
      console.log('VERBOSE: Updating preview screenshot for model with identifier: ' + request.params.identifier);
      console.log(`VERBOSE: Size before: ${Buffer.from(imagedata).length}`);
    }

    const collection = this.DBObjectsRepository.collection('model');

    let tempFile = base64img.imgSync(imagedata, '.', 'tmp');
    tempFile = readFileSync(tempFile);
    let final_image = '';
    await PNGtoJPEG({ quality: 60 })(tempFile).then(async jpeg_data => {
      final_image = `data:image/png;base64,${jpeg_data.toString('base64')}`;
    });
    const result = await collection.updateOne({ '_id': ObjectId(request.params.identifier) },
      { $set: { preview: `${final_image}` } });
    response.send((result.result.ok === 1) ? { status: 'ok', preview: `${final_image}` } : { status: 'error' });

    if (Verbose) {
      console.log('VERBOSE: Updating preview screenshot for model with identifier: ' + request.params.identifier);
      console.log(`VERBOSE: Size before: ${Buffer.from(final_image).length}`);
    }
  },
  resolve: async (obj, collection_name) => {
    if (Verbose) {
      console.log(`Resolving ${collection_name} ${(obj['_id']) ? obj['_id'] : obj}`);
    }
    const resolve_collection = this.DBObjectsRepository.collection(collection_name);
    const id = (obj['_id']) ? obj['_id'] : obj;
    return await resolve_collection.findOne({ '_id': (ObjectId.isValid(id)) ? ObjectId(id) : id })
      .then((resolve_result) => resolve_result);
  },
  /**
   * Express HTTP GET request
   * Finds any document in any collection by its MongoDB identifier
   * On success, sends a response containing the Object
   * TODO: Handle No Objects found?
   */
  getFromObjectCollection: (request, response) => {
    const RequestCollection = request.params.collection.toLowerCase();

    const collection = this.DBObjectsRepository.collection(RequestCollection);

    let searchParameter = { '_id': request.params.identifier };
    if (ObjectId.isValid(request.params.identifier)) {
      searchParameter = { '_id': ObjectId(request.params.identifier) };
    }

    switch (RequestCollection) {
      case 'compilation':
        collection.findOne(searchParameter).then(async (result: Compilation) => {
          if (result) {
            for (let i = 0; i < result.models.length; i++) {
              result.models[i] = await Mongo.resolve(result.models[i]._id, 'model');
            }

            response.send(result);
          } else {
            response.send({ status: 'ok' });
          }
        }).catch((db_error) => {
          console.error(db_error);
          response.send({ status: 'error' });
        });

        break;
      case 'digitalobject':
        collection.findOne(searchParameter).then(async (result) => {
          if (result) {
            const resolveTopLevel = async (obj, property, field) => {
              for (let i = 0; i < obj[property].length; i++) {
                obj[property][i] =
                  await resolveNestedInst(await Mongo.resolve(obj[property][i], field));
              }
            };
            const resolveNestedInst = async (obj) => {
              if (obj['person_institution'] && obj['person_institution'] === 'Neue Institution hinzufügen') {
                for (let j = 0; j < obj['person_institution_data'].length; j++) {
                  obj['person_institution_data'][j] =
                    await Mongo.resolve(obj['person_institution_data'][j], 'institution');
                }
              }
              return obj;
            };
            const props = [['digobj_rightsowner_person', 'person'], ['contact_person', 'person'], ['digobj_person', 'person'],
            ['digobj_rightsowner_institution', 'institution'], ['digobj_tags', 'tag']];
            for (let i = 0; i < props.length; i++) {
              await resolveTopLevel(result, props[i][0], props[i][1]);
            }
            for (let i = 0; i < result['phyObjs'].length; i++) {
              result['phyObjs'][i] = await Mongo.resolve(result['phyObjs'][i], 'physicalobject');
              await resolveTopLevel(result['phyObjs'][i], 'phyobj_rightsowner_person', 'person');
              await resolveTopLevel(result['phyObjs'][i], 'phyobj_rightsowner_institution', 'institution');
              await resolveTopLevel(result['phyObjs'][i], 'phyobj_person', 'person');
              await resolveTopLevel(result['phyObjs'][i], 'phyobj_institution', 'institution');
            }
            response.send(result);
          } else {
            response.send({ status: 'ok' });
          }
        });
        break;
      default:
        collection.findOne(searchParameter, (db_error, result) => {
          response.send(result ? result : { status: 'ok' });
        });
        break;
    }
  },
  /**
   * Express HTTP GET request
   * Finds all documents in any collection
   * On success, sends a response containing an Array
   * of all Objects in the specified collection
   * TODO: Handle No Objects found?
   */
  getAllFromObjectCollection: (request, response) => {
    const RequestCollection = request.params.collection.toLowerCase();

    const collection = this.DBObjectsRepository.collection(RequestCollection);

    switch (RequestCollection) {
      case 'compilation':
        collection.find({}).toArray(async (db_error, results) => {
          if (results) {
            const resultObject = results;
            // Returns an Array of Arrays of models
            const models = await Promise.all(results.map(async (result) => await Promise.all(result.models.map(async (model) =>
              await Mongo.resolve(model._id, 'model')))));

            // Insert array of models into result Object
            for (let i = resultObject.length - 1; i >= 0; i--) {
              resultObject[i].models = models[i];
            }

            response.send(resultObject);
          } else {
            response.send({ status: 'ok' });
          }
        });
        break;
      case 'model':
        collection.find({}).toArray((db_error, results) => {
          try {
            response.send(results.filter(model =>
              model.preview !== undefined).filter(model => model.preview.length > 0));
          } catch (err) {
            console.error(err);
            response.send([]);
          }
        });
        break;
      default:
        collection.find({}).toArray((db_error, result) => {
          response.send(result);
        });
        break;
    }
  }
};

/**
 * Initialization
 */
Mongo.init();

export { Mongo };
