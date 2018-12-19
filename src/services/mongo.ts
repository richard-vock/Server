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
import { Verbose } from '../environment';
import { inspect as InspectObject } from 'util';

import * as base64img from 'base64-img';
import * as PNGtoJPEG from 'png-to-jpeg';
import { readFile } from 'fs';

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
    Retry: 0,
    MaxRetries: 10,
    ReconnectInterval: undefined,
    /**
     * Initialize a MongoDB Client
     * uses hostname and port defined in Configuration file
     */
    initClient: () => {
        this.Client = new MongoClient(`mongodb://${Configuration.Mongo.Hostname}:${Configuration.Mongo.Port}/`, { useNewUrlParser: true });
    },
    /**
     * Make sure our predefined collections exist in the Database
     */
    initCollections: () => {
        this.Connection.then(() => {
            Configuration.Mongo.Databases.ObjectsRepository.Collections.forEach(collection => {
                this.DBObjectsRepository.createCollection(collection.toLowerCase());
            });
        });
    },
    /**
     * Establish connection to the server
     * Saving this as a variable allows re-using the same connection
     * This reduces latency on all calls
     * TODO: If the connection closes, re-open it
     */
    establishConnection: () => {
        this.Connection = this.Client.connect();
    },
    initReconnect: () => {
        this.Connection.then(() => {
            this.DBObjectsRepository.on('close', () => {
                console.log('Connection closed. Retrying...');
                setTimeout(() => {
                    Mongo.Connection = undefined;
                    Mongo.ReconnectInterval = setInterval(() => {
                        if (Mongo.Connection === undefined) {
                            Mongo.Retry++;
                            if (Mongo.Retry <= Mongo.MaxRetries) {
                                Mongo.establishConnection();
                            } else {
                                console.log(`Reconnect failed after ${Mongo.MaxRetries} tries`);
                                Mongo.ReconnectInterval = undefined;
                                Mongo.Retry = 0;
                            }
                        } else {
                            console.log('Reconnected!');
                            Mongo.ReconnectInterval = undefined;
                            Mongo.Retry = 0;
                        }
                    }, 1000);
                }, 1000);
            });
        });
    },
    /**
     * Save the most used Database as a variable
     * to reduce the amount of calls needed
     */
    initObjectsRepository: () => {
        this.Connection.then(() => {
            this.DBObjectsRepository = this.Client.db(Configuration.Mongo.Databases.ObjectsRepository.Name);
        });
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

        const resultObject = { ...request.body };

        /**
         * Adds data {field} to a collection {collection}
         * and returns the {_id} of the created object.
         * If {field} already has an {_id} property the server
         * will assume the object already exists in the collection
         * and instead return the existing {_id}
         */
        const addAndGetId = async (field, add_to_coll) => {
            return {
                '_id': (field['_id'] !== undefined && field['_id'].length > 0) ?
                    String(field['_id']) :
                    await this.DBObjectsRepository.collection(add_to_coll).insertOne(field).then(result => {
                        return String(result.ops[0]['_id']);
                    })
            };
        };


        const collection = this.DBObjectsRepository.collection('digitalobject');


        /**
         * Handle re-submit for changing a finished DigitalObject
         */
        if (resultObject['_id']) {
            console.log(`Re-submitting DigitalObject ${resultObject['_id']}`);
            collection.deleteOne({_id: resultObject['_id']});
        }

        /**
         * Use addAndGetId function on all Arrays containing
         * data that need to be added to collections
         */

        // TODO: Eleganter lösen
        resultObject['digobj_rightsowner_person'] = await Promise.all(
            resultObject['digobj_rightsowner_person'].map(async person => {
                if (person['person_institution'] === 'Neue Institution hinzufügen') {
                    const institution = person['person_institution_data'].pop();
                    const newInst = await addAndGetId(institution, 'institution');
                    person['person_institution_data'][0] = newInst;
                }
                return addAndGetId(person, 'person');
            }));

        resultObject['digobj_rightsowner_institution'] = await Promise.all(
            resultObject['digobj_rightsowner_institution'].map(async institution => addAndGetId(institution, 'institution')));

        resultObject['contact_person'] = await Promise.all(
            resultObject['contact_person'].map(async person => addAndGetId(person, 'person')));

        resultObject['digobj_person'] = await Promise.all(
            resultObject['digobj_person'].map(async person => {
                if (person['person_institution'] === 'Neue Institution hinzufügen') {
                    const institution = person['person_institution_data'].pop();
                    const newInst = await addAndGetId(institution, 'institution');
                    person['person_institution_data'][0] = newInst;
                }
                return addAndGetId(person, 'person');
            }));

        resultObject['phyObjs'] = await Promise.all(
            resultObject['phyObjs'].map(async phyObj => {
                if (phyObj['phyobj_rightsowner_person'].length > 0 && !phyObj['phyobj_rightsowner_person'][0]['_id']) {
                    phyObj['phyobj_rightsowner_person'] = await Promise.all(
                        phyObj['phyobj_rightsowner_person'].map(
                            phyObjRightsOwner => addAndGetId(phyObjRightsOwner, 'person')
                        ));
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
                                if (phyObjPerson['person_institution'] === 'Neue Institution hinzufügen') {
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
    addToObjectCollection: (request, response) => {
        this.Connection.then(async () => {
            const RequestCollection = request.params.collection.toLowerCase();

            if (Verbose) {
                console.log('VERBOSE: Adding to the following collection ' + RequestCollection);
            }

            const collection = this.DBObjectsRepository.collection(RequestCollection);

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

                        // Re-create compilation instance
                        collection.deleteOne({_id: resultObject['_id']}, (del_error, del_result) => {
                            if (del_error) {
                                console.error('Failed to remove compilation instance');
                            } else {
                                collection.insertOne(resultObject, (db_error, db_result) => {
                                    if (db_error) {
                                        console.error('Failed to insert compilation');
                                    } else {
                                        console.log(`Re-inserted compilation ${db_result.ops[0]['_id']}`);
                                        response.send(db_result.ops[0]);
                                    }
                                });
                            }
                        });
                    } else {
                        // Add new compilation
                        collection.insertOne(resultObject, (db_error, db_result) => {
                            response.send(db_result.ops);

                            if (Verbose) {
                                console.log(`VERBOSE: Success! Added new compilation ${db_result.ops[0]['_id']}`);
                            }
                        });
                    }
                    break;

                default:
                    collection.insertOne(request.body, (db_error, result) => {
                        response.send(result.ops);

                        if (Verbose) {
                            console.log('VERBOSE: Success! Added the following');
                            console.log(result.ops);
                        }
                    });
                    break;
            }
        });
    },
    /**
     * Express HTTP POST request
     * Handles multiple documents that need to be added
     * to our Database
     * request.body is any Array of JavaScript Objects
     * On success, sends a response containing the added Array
     */
    addMultipleToObjectCollection: (request, response) => {
        this.Connection.then(() => {
            if (Verbose) {
                console.log('VERBOSE: Adding the following document to collection ' + request.params.collection);
                console.log(request.params.collection.toLowerCase());
                console.log(InspectObject(request.body));
            }

            const collection = this.DBObjectsRepository.collection(request.params.collection.toLowerCase());

            collection.insertMany(request.body, (db_error, result) => {
                response.send(result.ops);
                if (Verbose) {
                    console.log('VERBOSE: Success! Added the following');
                    console.log(result.ops);
                }
            });
        });
    },
    /**
     * TODO: Handle user accounts
     */
    addToAccounts: (collection, data) => {

    },
    /**
     * Express HTTP POST request
     * Finds a model by it's ObjectId and
     * updates it's preview screenshot
     */
    updateScreenshot: (request, response) => {
        this.Connection.then(() => {
            const imagedata = request.body.data;
            if (Verbose) {
                console.log('VERBOSE: Updating preview screenshot for model with identifier: ' + request.params.identifier);
                console.log(`VERBOSE: Size before: ${Buffer.from(imagedata).length}`);
            }

            const collection = this.DBObjectsRepository.collection('model');


            base64img.img(imagedata, '.', 'tmp', (err, filepath) => {
                if (err) {
                    console.error(err);
                    response.send('Failed compressing image');
                    return;
                }

                readFile(filepath, (fs_err, fs_data) => {
                    if (fs_err) {
                        console.error(fs_err);
                        response.send('Failed compressing image');
                        return;
                    }

                    PNGtoJPEG({ quality: 60 })(fs_data).then(jpeg_data => {
                        jpeg_data = new Buffer(jpeg_data).toString('base64');

                        if (Verbose) {
                            console.log('VERBOSE: Updating preview screenshot for model with identifier: ' + request.params.identifier);
                            console.log(`VERBOSE: Size before: ${Buffer.from(jpeg_data).length}`);
                        }

                        collection.findOneAndUpdate(
                            { '_id': ObjectId(request.params.identifier) },
                            { $set: { preview: request.body.data } },
                            (db_error, result) => {
                                console.log(result);
                                response.send(result);
                            });
                    });
                });
            });
        });
    },
    resolve: async (obj, collection_name) => {
        if (Verbose) {
            if (obj['_id']) {
                console.log(`Resolving ${collection_name} ${obj['_id']}`);
            } else {
                console.log(`Resolving ${collection_name} ${obj}`);
            }
        }
        const resolve_collection = this.DBObjectsRepository.collection(collection_name);
        if (obj['_id']) {
            return await resolve_collection.findOne({ '_id': ObjectId(obj['_id']) }).then((resolve_result) => resolve_result);
        } else {
            return await resolve_collection.findOne({ '_id': ObjectId(obj) }).then((resolve_result) => resolve_result);
        }
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
                        result.models = await Promise.all(result.models.map(async (model) =>
                            await Mongo.resolve(model._id, 'model')));
                        response.send(result);
                    } else {
                        response.send({});
                    }
                }).catch((db_error) => {
                    console.error(db_error);
                    response.sendStatus(400);
                });

                break;
            case 'digitalobject':
                collection.findOne(searchParameter).then(async (result) => {
                    if (result) {
                        result['digobj_rightsowner_person'] = await Promise.all(
                            result['digobj_rightsowner_person'].map(async (person) => {
                                const newPerson = await Mongo.resolve(person, 'person');
                                if (newPerson['person_institution'] === 'Neue Institution hinzufügen') {
                                    newPerson['person_institution_data'] = await Promise.all(
                                        newPerson['person_institution_data']
                                            .map(async (institution) => await Mongo.resolve(institution, 'institution')));
                                }
                                return newPerson;
                            }));
                        result['digobj_rightsowner_institution'] = await Promise.all(
                            result['digobj_rightsowner_institution'].map(async (institution) =>
                                await Mongo.resolve(institution, 'institution')));
                        result['contact_person'] = await Promise.all(
                            result['contact_person'].map(async (person) =>
                                await Mongo.resolve(person, 'person')));
                        result['digobj_person'] = await Promise.all(
                            result['digobj_person'].map(async (person) => {
                                const newPerson = await Mongo.resolve(person, 'person');
                                if (newPerson['person_institution'] === 'Neue Institution hinzufügen') {
                                    newPerson['person_institution_data'] = await Promise.all(
                                        newPerson['person_institution_data']
                                            .map(async (institution) => await Mongo.resolve(institution, 'institution')));
                                }
                                return newPerson;
                            }));
                        if (result['digobj_tags'].length > 0) {
                            result['digobj_tags'] = await Promise.all(
                                result['digobj_tags'].map(async (tag) =>
                                    await Mongo.resolve(tag, 'tag')));
                        }
                        result['phyObjs'] = await Promise.all(
                            result['phyObjs'].map(async (resPhyObj) => {
                                const phyObj = await Mongo.resolve(resPhyObj, 'physicalobject');
                                phyObj['phyobj_rightsowner_person'] = await Promise.all(phyObj['phyobj_rightsowner_person']
                                    .map(async (person) =>
                                        await Mongo.resolve(person, 'person')));
                                phyObj['phyobj_rightsowner_institution'] = await Promise.all(phyObj['phyobj_rightsowner_institution']
                                    .map(async (institution) =>
                                        await Mongo.resolve(institution, 'institution')));

                                phyObj['phyobj_person'] = await Promise.all(phyObj['phyobj_person'].map(async (person) => {
                                    const newPerson = await Mongo.resolve(person, 'person');
                                    if (newPerson['person_institution'] === 'Neue Institution hinzufügen') {
                                        newPerson['person_institution_data'] = await Promise.all(
                                            newPerson['person_institution_data']
                                                .map(async (institution) => await Mongo.resolve(institution, 'institution')));
                                    }
                                    return newPerson;
                                }));
                                phyObj['phyobj_institution'] = await Promise.all(phyObj['phyobj_institution'].map(async (institution) =>
                                    await Mongo.resolve(institution, 'institution')));
                                return phyObj;
                            }));
                        response.send(result);
                    } else {
                        response.send({});
                    }
                });
                break;
            default:
                collection.findOne(searchParameter, (db_error, result) => {
                    if (result) {
                        response.send(result);
                    } else {
                        response.send({});
                    }
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
                        response.send({});
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

const ReconnectProxy = new Proxy(Mongo, {
    get(target, property, receiver) {
        console.log(target);
        console.log(property);
        console.log(receiver);
        return target[property];
    }
});

/**
 * Initialization
 */
Mongo.initClient();
Mongo.establishConnection();
Mongo.initObjectsRepository();
Mongo.initCollections();
Mongo.initReconnect();

export { Mongo };
