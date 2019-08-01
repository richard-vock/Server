import flatten from 'flatten';
import { Collection, ObjectId } from 'mongodb';

// tslint:disable-next-line:max-line-length
import { IAnnotation, ICompilation, IEntity, IGroup, ILDAPData, IMetaDataDigitalEntity, IMetaDataPhysicalEntity, IUserData } from '../interfaces';

import { Logger } from './logger';
import { Mongo } from './mongo';
import { isAnnotation } from './typeguards';

const updateAnnotationList =
  async (entityOrCompId: string, add_to_coll: string, annotationId: string) => {
    const obj: IEntity | ICompilation = await Mongo.resolve(entityOrCompId, add_to_coll, 0);
    // Create annotationList if missing
    obj.annotationList = (obj.annotationList)
      ? obj.annotationList : [];
    // Filter null
    obj.annotationList = obj.annotationList
      .filter(_annotation => _annotation);

    const doesAnnotationExist =
      (obj.annotationList.filter(_annotation => _annotation) as Array<IAnnotation | ObjectId>)
        .find(_annotation => (isAnnotation(_annotation))
          ? _annotation._id.toString() === annotationId
          : _annotation.toString() === annotationId);

    // Add annotation to list if it doesn't exist
    if (!doesAnnotationExist) obj.annotationList.push(new ObjectId(annotationId));

    // We resolved the compilation earlier, so now we have to replace
    // the resolved annotations with their ObjectId again
    obj.annotationList = (obj.annotationList as Array<IAnnotation | ObjectId>)
      .map(_annotation => (isAnnotation(_annotation))
        ? new ObjectId(_annotation._id)
        : _annotation);

    return obj;
  };

const saveCompilation = async (compilation: ICompilation, userData: ILDAPData) => {
  compilation.annotationList = (compilation.annotationList)
    ? compilation.annotationList : [];
  compilation.relatedOwner = {
    _id: userData._id,
    username: userData.username,
    fullname: userData.fullname,
  };
  // Compilations should have all their entities referenced by _id
  compilation.entities =
    (compilation.entities.filter(entity => entity) as IEntity[])
      .map(entity => ({ _id: new ObjectId(entity['_id']) }));

  await Mongo.insertCurrentUserData(userData, compilation._id, 'compilation');
  return compilation;
};

const saveAnnotation = async (
  annotation: IAnnotation, userData: ILDAPData, doesEntityExist: boolean) => {
  return new Promise<IAnnotation>(async (resolve, reject) => {
    // If the Annotation already exists, check for owner
    const isAnnotationOwner = (doesEntityExist)
      ? await Mongo.isUserOwnerOfEntity(userData, annotation._id)
      : true;
    // Check if anything was missing for safety
    if (!annotation || !annotation.target || !annotation.target.source) {
      return reject({
        status: 'error', message: 'Invalid annotation',
        invalidEntity: annotation,
      });
    }
    const source = annotation.target.source;
    if (!source) {
      return reject({ status: 'error', message: 'Missing source' });
    }
    if (!annotation.body || !annotation.body.content
      || !annotation.body.content.relatedPerspective) {
      return reject({ status: 'error', message: 'Missing body.content.relatedPerspective' });
    }
    annotation.body.content.relatedPerspective.preview = await Mongo.saveBase64toImage(
      annotation.body.content.relatedPerspective.preview, 'annotation', annotation._id);

    // Assume invalid data
    const relatedEntityId = source.relatedEntity as string | undefined;
    const relatedCompId = source.relatedCompilation;
    // Check if === undefined because otherwise this quits on empty string
    if (relatedEntityId === undefined || relatedCompId === undefined) {
      return reject({ status: 'error', message: 'Related entity or compilation undefined' });
    }

    const validEntity = ObjectId.isValid(relatedEntityId);
    const validCompilation = ObjectId.isValid(relatedCompId);

    if (!validEntity) {
      return reject({ status: 'error', message: 'Invalid related entity id' });
    }

    // Case: Trying to change Default Annotations
    const isEntityOwner = await Mongo.isUserOwnerOfEntity(userData, relatedEntityId);
    if (!validCompilation && !isEntityOwner) {
      return reject({ status: 'error', message: 'Permission denied' });
    }

    // Case: Compilation owner trying to re-rank annotations
    const isCompilationOwner = await Mongo.isUserOwnerOfEntity(userData, relatedCompId);
    if (!isAnnotationOwner) {
      if (isCompilationOwner) {
        const oldAnnotation: IAnnotation | null = await Mongo.resolve(annotation, 'annotation');
        // Compilation owner is not supposed to change the annotation body
        if (oldAnnotation && oldAnnotation.body === annotation.body) {
          return reject({ status: 'error', message: 'Permission denied' });
        }
      } else {
        return reject({ status: 'error', message: 'Permission denied' });
      }
    }

    // Update data inside of annotation
    annotation.generated = (annotation.generated)
      ? annotation.generated : new Date().toISOString();
    annotation.lastModificationDate = new Date().toISOString();
    annotation.lastModifiedBy._id = userData._id;
    annotation.lastModifiedBy.name = userData.fullname;
    annotation.lastModifiedBy.type = 'person';

    const entityOrCompId = (!validCompilation) ? relatedEntityId : relatedCompId;
    const requestedCollection = (!validCompilation) ? 'entity' : 'compilation';
    const resultEntityOrComp =
      await updateAnnotationList(
        entityOrCompId, requestedCollection,
        annotation._id.toString());

    // Finally we update the annotationList in the compilation
    const coll: Collection = Mongo.getEntitiesRepository()
      .collection(requestedCollection);
    const listUpdateResult = await coll
      .updateOne(
        { _id: new ObjectId(entityOrCompId) },
        { $set: { annotationList: resultEntityOrComp.annotationList } });

    if (listUpdateResult.result.ok !== 1) {
      Logger.err(`Failed updating annotationList of ${requestedCollection} ${entityOrCompId}`);
      return reject({ status: 'error' });
    }

    if (isAnnotationOwner) {
      await Mongo.insertCurrentUserData(userData, annotation._id, 'annotation');
    }
    resolve(annotation);
  });
};

const saveEntity = async (entity: IEntity, userData: ILDAPData) => {
  /* Preview image URLs might have a corrupted address
 * because of Kompakkt runnning in an iframe
 * This removes the host address from the URL
 * so images will load correctly */
  if (entity.settings && entity.settings.preview) {
    entity.settings.preview = await Mongo.saveBase64toImage(
      entity.settings.preview, 'entity', entity._id);
  }
  await Mongo.insertCurrentUserData(userData, entity._id, 'entity');
  return entity;
};

const saveGroup = async (group: IGroup, userData: ILDAPData) => {
  const strippedUserData: IUserData = {
    username: userData.username,
    fullname: userData.fullname,
    _id: userData._id,
  };
  group.creator = strippedUserData;
  group.members = [strippedUserData];
  group.owners = [strippedUserData];
  return group;
};

const saveDigitalEntity = async (digitalentity: IMetaDataDigitalEntity) => {
  /**
   * Handle re-submit for changing a finished DigitalEntity
   */
  const isResObjIdValid = ObjectId.isValid(digitalentity._id);
  digitalentity._id = isResObjIdValid
    ? new ObjectId(digitalentity._id) : new ObjectId();
  Logger.info(`${isResObjIdValid ? 'Re-' : ''}Submitting DigitalEntity ${digitalentity._id}`);

  // We overwrite this in the phyobj loop so we can
  let currentPhyObjId = '';

  //// FILTER FUNCTIONS ////
  const addToRightsOwnerFilter = (person: any) =>
    person['value'] && person['value'].indexOf('add_to_new_rightsowner') !== -1;
  const filterEntitiesWithoutID = (obj: any) => ObjectId.isValid(obj._id);

  /**
   * Adds data {field} to a collection {collection}
   * and returns the {_id} of the created entity.
   * If {field} already has an {_id} property the server
   * will assume the entity already exists in the collection
   * and instead return the existing {_id}
   */
  // TODO: Roles interface?
  const addAndGetId = async (in_field: any, add_to_coll: string, new_roles?: any) => {
    let field = in_field;
    if (add_to_coll === 'person') {
      field = await addNestedInstitution(field);
    }
    const coll: Collection = Mongo
      .getEntitiesRepository()
      .collection(add_to_coll);
    const isPersonOrInstitution = ['person', 'institution'].includes(add_to_coll);
    const _digId = ((currentPhyObjId !== '') ? currentPhyObjId : digitalentity._id)
      .toString();
    // By default, update/create the document
    // but if its an existing person/institution
    // fetch the entity and update roles
    const isIdValid = ObjectId.isValid(field['_id']);
    const _id = (isIdValid) ? new ObjectId(field['_id']) : new ObjectId();
    if (isIdValid) {
      const findResult = await coll.findOne({ _id });
      if (findResult) {
        field = { ...findResult, ...field };
      }
    }
    if (isPersonOrInstitution) {
      const doRolesExist = (field['roles'] !== undefined);

      field['roles'] = doRolesExist ? field['roles'] : {};
      field['roles'][_digId] = field['roles'][_digId]
        ? field['roles'][_digId]
        : [];

      for (const prop of ['institution_role', 'person_role']) {
        if (!field[prop]) continue;
        field[prop] = (new_roles) ? new_roles : field[prop];
        // Add new roles to person or institution
        field['roles'][_digId] = doRolesExist
          ? flatten([field['roles'][_digId], field[prop]])
          : flatten([field[prop]]);
        field['roles'][_digId] = Array.from(new Set(field['roles'][_digId]));
        field[prop] = [];
      }
    }

    // Make sure there are no null roles
    if (field['roles'] && field['roles'][_digId]) {
      field['roles'][_digId] = field['roles'][_digId]
        .filter((obj: any) => obj);
    }
    // We cannot update _id property when upserting
    // so we remove this beforehand
    // tslint:disable-next-line
    delete field['_id'];
    const updateResult = await coll.updateOne(
      { _id },
      { $set: field, $setOnInsert: { _id } },
      { upsert: true });

    const resultId = (updateResult.upsertedId)
      ? updateResult.upsertedId._id
      : _id;
    return { _id: resultId };
  };

  const addNestedInstitution = async (person: any) => {
    if (!person['person_institution']) return person;
    if (!(person['person_institution'] instanceof Array)) return person;
    for (let i = 0; i < person['person_institution'].length; i++) {
      if (person['person_institution'][i]['value'] !== 'add_new_institution') continue;
      const institution = person['person_institution_data'][i];
      const newInst = await addAndGetId(institution, 'institution');
      person['person_institution_data'][i] = newInst;
    }
    return person;
  };

  const concatFix = (...arr: any[]) => {
    let result: any[] = [].concat(arr[0]);
    for (let i = 1; i < arr.length; i++) {
      result = result.concat(arr[i]);
    }
    result = result.filter(filterEntitiesWithoutID);
    const final: any[] = [];
    for (const res of result) {
      const obj = { _id: new ObjectId(res._id) };
      const filtered = final.filter(_obj => _obj._id.toString() === obj._id.toString());
      if (filtered.length === 0) final.push(obj);
    }
    return final;
  };

  // Always single
  let digobj_rightsowner: any[] = digitalentity.digobj_rightsowner;
  let digobj_rightsowner_person: any[] = digitalentity.digobj_rightsowner_person;
  let digobj_rightsowner_institution: any[] = digitalentity.digobj_rightsowner_institution;
  // Can be multiple
  let contact_person: any[] = digitalentity.contact_person;
  let contact_person_existing: any[] = digitalentity.contact_person_existing;
  let digobj_person: any[] = digitalentity.digobj_person;
  let digobj_person_existing: any[] = digitalentity.digobj_person_existing;
  const digobj_tags: any[] = digitalentity.digobj_tags;
  const phyObjs: any[] = digitalentity.phyObjs;

  const handleRightsOwnerBase = async (
    inArr: any[], existArrs: any[],
    roleProperty: string, add_to_coll: string, fixedRoles?: any[]) => {
    for (let x = 0; x < inArr.length; x++) {
      const toConcat: any = [];
      for (const existArr of existArrs) {
        const filtered = existArr.filter(addToRightsOwnerFilter);
        if (filtered.length !== 1) continue;
        const roles = (filtered[0][roleProperty] && filtered[0][roleProperty].length > 0)
          ? filtered[0][roleProperty] : fixedRoles;
        toConcat.push(roles);
      }
      const newRoles = flatten([inArr[x][roleProperty], toConcat]);
      inArr[x] = await addAndGetId(inArr[x], add_to_coll, newRoles);
    }
  };

  await handleRightsOwnerBase(
    digobj_rightsowner_person, [digobj_person_existing, contact_person_existing],
    'person_role', 'person', ['CONTACT_PERSON']);

  const handleRightsOwnerSelector = async (
    inArr: any[],
    personArr: any[],
    instArr: any[],
    selector: any) => {
    for (const obj of inArr) {
      switch (obj['value']) {
        case 'add_new_person':
          personArr[0] = await addAndGetId({ ...personArr[0] }, 'person');
          break;
        case 'add_new_institution':
          instArr[0] = await addAndGetId({ ...instArr[0] }, 'institution');
          break;
        default:
          const newRightsOwner = { ...obj };
          const personSelector = 1;
          const instSelector = 2;
          const selected = parseInt(selector, 10);
          switch (selected) {
            case personSelector:
              personArr[0] = await addAndGetId(newRightsOwner, 'person');
              break;
            case instSelector:
              instArr[0] = await addAndGetId(newRightsOwner, 'institution');
              break;
            default:
          }
      }
    }
  };

  await handleRightsOwnerSelector(
    digobj_rightsowner, digobj_rightsowner_person,
    digobj_rightsowner_institution, digitalentity.digobj_rightsownerSelector);

  /**
   * Newly added rightsowner persons and institutions can be
   * selected in other input fields as 'same as new rightsowner'.
   * this function handles these cases
   */
  const handleRightsOwnerAndExisting = async (
    inArr: any[],
    outArr: any[],
    add_to_coll: string,
    idIfSame: string | ObjectId,
    roleProperty: string,
    role?: string) => {
    for (const obj of inArr) {
      const newObj: any = {};
      newObj[roleProperty] = (role) ? role : obj[roleProperty];
      newObj['_id'] = ObjectId.isValid(obj['_id']) ? new ObjectId(obj['_id'])
        : (ObjectId.isValid(idIfSame) ? new ObjectId(idIfSame) : new ObjectId());
      const newRoles = newObj[roleProperty];
      outArr.push(await addAndGetId(newObj, add_to_coll, newRoles));
    }
  };

  /**
   * Simple cases where the item only needs to be added for nesting
   */
  const handleSimpleCases = async (inArrAndOutArr: any[], add_to_coll: string) => {
    for (let i = 0; i < inArrAndOutArr.length; i++) {
      inArrAndOutArr[i] = await addAndGetId(inArrAndOutArr[i], add_to_coll);
    }
  };

  await handleSimpleCases(digobj_rightsowner_institution, 'institution');
  await handleSimpleCases(contact_person, 'person');
  await handleSimpleCases(digobj_person, 'person');
  await handleSimpleCases(digobj_tags, 'tag');

  /**
   * Cases where persons either exist or are added to the new rightsowner
   */
  const _tempId = (digobj_rightsowner_person[0] && digobj_rightsowner_person[0]['_id'])
    ? digobj_rightsowner_person[0]['_id'] : '';
  await handleRightsOwnerAndExisting(
    contact_person_existing, contact_person, 'person',
    _tempId, 'person_role', 'CONTACT_PERSON');
  await handleRightsOwnerAndExisting(
    digobj_person_existing, digobj_person, 'person',
    _tempId, 'person_role');

  for (let i = 0; i < phyObjs.length; i++) {
    const phyObj: IMetaDataPhysicalEntity = phyObjs[i];
    let phyobj_rightsowner: any[] = phyObj.phyobj_rightsowner;
    let phyobj_rightsowner_person: any[] = phyObj.phyobj_rightsowner_person;
    let phyobj_rightsowner_institution: any[] = phyObj.phyobj_rightsowner_institution;
    let phyobj_person: any[] = phyObj.phyobj_person;
    let phyobj_person_existing: any[] = phyObj.phyobj_person_existing;
    let phyobj_institution: any[] = phyObj.phyobj_institution;
    let phyobj_institution_existing: any[] = phyObj.phyobj_institution_existing;

    const isPhyObjIdValid = ObjectId.isValid(phyObj._id);
    phyObj._id = isPhyObjIdValid ? new ObjectId(phyObj._id) : new ObjectId();
    currentPhyObjId = phyObj._id.toString();

    await handleRightsOwnerBase(
      phyobj_rightsowner_person, [phyobj_person_existing],
      'person_role', 'person');
    await handleRightsOwnerBase(
      phyobj_rightsowner_institution, [phyobj_institution_existing],
      'institution_role', 'institution');

    await handleRightsOwnerSelector(
      phyobj_rightsowner, phyobj_rightsowner_person,
      phyobj_rightsowner_institution, phyObj.phyobj_rightsownerSelector);

    await handleSimpleCases(phyobj_person, 'person');
    await handleSimpleCases(phyobj_institution, 'institution');

    if (phyobj_rightsowner_person[0]) {
      await handleRightsOwnerAndExisting(
        phyobj_person_existing, phyobj_person, 'person',
        phyobj_rightsowner_person[0], 'person_role');
    } else if (phyobj_rightsowner_institution[0]) {
      await handleRightsOwnerAndExisting(
        phyobj_institution_existing, phyobj_institution, 'institution',
        phyobj_rightsowner_institution[0]['_id'], 'institution_role');
    }

    await handleRightsOwnerAndExisting(
      phyobj_person_existing, phyobj_person, 'person',
      '', 'person_role');
    await handleRightsOwnerAndExisting(
      phyobj_institution_existing, phyobj_institution, 'institution',
      '', 'institution_role');

    phyobj_rightsowner =
      concatFix(phyobj_rightsowner, phyobj_rightsowner_institution, phyobj_rightsowner_person);
    phyobj_person_existing = concatFix(phyobj_person_existing, phyobj_person);
    phyobj_institution_existing = concatFix(phyobj_institution_existing, phyobj_institution);
    phyobj_rightsowner_institution = phyobj_rightsowner_person =
      phyobj_person = phyobj_institution = [];
    const finalPhy = {
      ...phyObj, phyobj_rightsowner, phyobj_rightsowner_person,
      phyobj_rightsowner_institution, phyobj_person, phyobj_person_existing,
      phyobj_institution, phyobj_institution_existing,
    };
    phyObjs[i] = await addAndGetId(finalPhy, 'physicalentity');
  }

  /**
   * Re-assignment:
   * When editing a finished entity we want to have all persons/institutions that have been added
   * on the previous submit to be existing persons/institutions, otherwise they would fill up
   * the metadata form in the frontend
   * Also: remove everything without an _id (which is the remainings from tag-input)
   */
  digobj_person_existing = concatFix(digobj_person_existing, digobj_person);
  contact_person_existing = concatFix(contact_person_existing, contact_person);
  digobj_rightsowner =
    concatFix(digobj_rightsowner, digobj_rightsowner_institution, digobj_rightsowner_person);

  // Empty the arrays that contained newly created persons/institutions
  digobj_rightsowner_institution = digobj_rightsowner_person =
    contact_person = digobj_person = [];

  const finalEntity = {
    ...digitalentity, digobj_rightsowner_person, digobj_rightsowner_institution,
    contact_person, contact_person_existing, digobj_person_existing,
    digobj_person, digobj_tags, phyObjs, digobj_rightsowner,
  };

  return finalEntity;
};

export { saveAnnotation, saveCompilation, saveDigitalEntity, saveGroup, saveEntity };
