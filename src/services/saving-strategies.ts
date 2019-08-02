import { Collection, ObjectId } from 'mongodb';

// tslint:disable-next-line:max-line-length
import { IAnnotation, ICompilation, IEntity, IGroup, ILDAPData, IMetaDataDigitalEntity, IMetaDataPhysicalEntity, IMetaDataTag, IMetaDataPerson, IMetaDataInstitution, IUserData } from '../interfaces';

import { Logger } from './logger';
import { Mongo } from './mongo';
import { isAnnotation, isDigitalEntity } from './typeguards';

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

const saveMetaDataEntity = async (
  entity: IMetaDataDigitalEntity | IMetaDataPhysicalEntity, userData: ILDAPData,
) => {
  const newEntity = { ...entity };

  const saveInstitution = async (institution: IMetaDataInstitution) => {
    const resolved = await Mongo.resolve(institution, 'institution');
    institution._id = (resolved)
      ? resolved._id
      : new ObjectId();
    // If person exists, combine roles
    if (resolved) {
      institution.roles = { ...institution.roles, ...resolved.roles };
    }

    if (!institution.roles) {
      institution.roles = {};
    }
    const id = newEntity._id.toString();
    institution.roles[id] = institution.role;

    return Mongo.getEntitiesRepository()
      .collection('institution')
      .updateOne(Mongo.query(institution._id), { $set: { ...institution } }, { upsert: true })
      .then(res => {
        const _id = res.upsertedId._id ? res.upsertedId._id : institution._id;
        Mongo.insertCurrentUserData(userData, _id, 'institution');
        return _id;
      });
  };

  const savePerson = async (person: IMetaDataPerson) => {
    const resolved = await Mongo.resolve(person, 'person');
    person._id = (resolved)
      ? resolved._id
      : new ObjectId();
    // If person exists, combine roles
    if (resolved) {
      person.roles = { ...person.roles, ...resolved.roles };
    }

    if (!person.roles) {
      person.roles = {};
    }

    const id = newEntity._id.toString();
    person.roles[id] = person.role;

    for (let i = 0; i < person.institution.length; i++) {
      person.institution[i] = (await saveInstitution(person.institution[i])) as any;
    }

    return Mongo.getEntitiesRepository()
      .collection('person')
      .updateOne(Mongo.query(person._id), { $set: { ...person } }, { upsert: true })
      .then(res => {
        const _id = res.upsertedId._id ? res.upsertedId._id : person._id;
        Mongo.insertCurrentUserData(userData, _id, 'person');
        return _id;
      });
  };

  for (let i = 0; i < newEntity.persons.length; i++) {
    newEntity.persons[i] = (await savePerson(newEntity.persons[i])) as any;
  }

  for (let i = 0; i < newEntity.institutions.length; i++) {
    newEntity.institutions[i] = (await saveInstitution(newEntity.institutions[i])) as any;
  }

  if (isDigitalEntity(newEntity)) {
    for (let i = 0; i < newEntity.tags.length; i++) {
      const tag: IMetaDataTag = (typeof newEntity.tags[i] === 'string')
        ? { _id: new ObjectId(), value: (newEntity.tags[i] as string) }
        : (newEntity.tags[i] as IMetaDataTag);

      tag._id = ObjectId.isValid(tag._id)
        ? tag._id
        : new ObjectId();

      newEntity.tags[i] = await Mongo.getEntitiesRepository()
        .collection('tag')
        .updateOne(Mongo.query(tag._id), { $set: { ...tag } }, { upsert: true })
        .then(res => {
          const _id = res.upsertedId._id ? res.upsertedId._id : tag._id;
          Mongo.insertCurrentUserData(userData, _id, 'tag');
          return _id;
        }) as any;
    }
  }

  return newEntity;
};

const saveDigitalEntity = async (digitalentity: IMetaDataDigitalEntity, userData: ILDAPData) => {
  const newEntity = await saveMetaDataEntity(digitalentity, userData) as IMetaDataDigitalEntity;

  for (let i = 0; i < newEntity.phyObjs.length; i++) {
    newEntity.phyObjs[i]._id = ObjectId.isValid(newEntity.phyObjs[i]._id)
      ? newEntity.phyObjs[i]._id
      : new ObjectId();
    const savedEntity = await saveMetaDataEntity(newEntity.phyObjs[i], userData) as IMetaDataPhysicalEntity;
    newEntity.phyObjs[i] = (await Mongo.getEntitiesRepository()
      .collection('physicalentity')
      .updateOne(Mongo.query(savedEntity._id), { $set: { ...savedEntity } }, { upsert: true })
      .then(res => {
        const _id = res.upsertedId._id ? res.upsertedId._id : savedEntity._id;
        Mongo.insertCurrentUserData(userData, _id, 'physicalentity');
        return _id;
      })) as any;
  }

  return newEntity;
};

export { saveAnnotation, saveCompilation, saveDigitalEntity, saveGroup, saveEntity };
