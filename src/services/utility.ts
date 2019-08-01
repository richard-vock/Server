import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';

import { IAnnotation, ICompilation, IEntity, ILDAPData } from '../interfaces';

import { Mongo } from './mongo';
import { isAnnotation } from './typeguards';

interface IUtility {
  findAllEntityOwnersRequest(request: Request, response: Response): any;
  findAllEntityOwners(entityId: string): any;
  countEntityUses(request: Request, response: Response): any;
  addAnnotationsToAnnotationList(request: Request, response: Response): any;
  applyActionToEntityOwner(request: Request, response: Response): any;
}

const Utility: IUtility = {
  findAllEntityOwnersRequest: async (request, response) => {
    const entityId = request.params.identifier;
    if (!ObjectId.isValid(entityId)) {
      response.send({ status: 'error', message: 'Invalid entity _id ' });
      return;
    }
    const accounts = await Utility.findAllEntityOwners(entityId);
    response.send({ status: 'ok', accounts });
  },
  findAllEntityOwners: async (entityId: string) => {
    const AccDB = Mongo.getAccountsRepository();
    const ldap = AccDB.collection<ILDAPData>('users');
    const accounts = (await ldap.find({})
      .toArray())
      .filter(userData => {
        const Entities = JSON.stringify(userData.data.entity);
        return (Entities) ? Entities.indexOf(entityId) !== -1 : false;
      })
      .map(userData => ({
        fullname: userData.fullname,
        username: userData.username,
        _id: userData._id,
      }));
    return accounts;
  },
  countEntityUses: async (request, response) => {
    const entityId = request.params.identifier;
    if (!ObjectId.isValid(entityId)) {
      response.send({ status: 'error', message: 'Invalid entity _id ' });
      return;
    }

    const ObjDB = Mongo.getEntitiesRepository();
    const compilations = (await ObjDB.collection<ICompilation>('compilation')
      .find({})
      .toArray())
      .filter(comp => {
        const Entities = JSON.stringify(comp.entities);
        return Entities.indexOf(entityId) !== -1;
      });
    const occurences = compilations.length;

    response.send({ status: 'ok', occurences, compilations });
  },
  addAnnotationsToAnnotationList: async (request, response) => {
    const annotations = request.body.annotations;
    if (!annotations || !Array.isArray(annotations)) {
      response.send({ status: 'error', message: 'No annotation array sent' });
      return;
    }

    const compId = request.params.identifier;
    if (!compId || !ObjectId.isValid(compId)
      || await Mongo.resolve(compId, 'compilation') === undefined) {
      response.send({ status: 'error', message: 'Invalid compilation given' });
      return;
    }

    const ObjDB = Mongo.getEntitiesRepository();
    const CompColl = ObjDB.collection<ICompilation>('compilation');
    const compilation = await CompColl.findOne({ _id: new ObjectId(compId) });
    if (!compilation) {
      response.send({ status: 'error', message: 'Compilation not found' });
      return;
    }

    const resolvedAnnotations = await Promise.all(annotations
      .filter(ann => ObjectId.isValid(ann))
      .map(ann => Mongo.resolve(ann, 'annotation')));
    const validAnnotations = resolvedAnnotations
      .filter(ann => ann !== undefined && ann)
      .map(ann => {
        ann['_id'] = new ObjectId();
        ann['target']['source']['relatedCompilation'] = request.params.identifier;
        ann['lastModificationDate'] = new Date().toISOString();
        return ann;
      });
    const AnnColl = ObjDB.collection<IAnnotation>('annotation');
    const insertResult = await AnnColl.insertMany(validAnnotations);
    if (insertResult.result.ok !== 1) {
      response.send({ status: 'error', message: 'Failed inserting Annotations' });
      return;
    }

    compilation.annotationList = (compilation.annotationList)
      ? compilation.annotationList : [];
    compilation.annotationList = Array.from(new Set(
      (compilation.annotationList.filter(ann => ann) as Array<IAnnotation | ObjectId>)
        .concat(validAnnotations)
        .map(ann => isAnnotation(ann) ? new ObjectId(ann['_id']) : new ObjectId(ann)),
    ));

    const updateResult = await CompColl
      .updateOne(
        { _id: new ObjectId(compId) },
        { $set: { annotationList: compilation['annotationList'] } });
    if (updateResult.result.ok !== 1) {
      response.send({ status: 'error', message: 'Failed updating annotationList' });
      return;
    }

    // Add Annotations to LDAP user
    validAnnotations.forEach(ann => Mongo.insertCurrentUserData(request, ann['_id'], 'annotation'));
    response.send({ status: 'ok', ...await Mongo.resolve(compId, 'compilation') });
  },
  applyActionToEntityOwner: async (request, response) => {
    const command = request.body.command;
    if (!['add', 'remove'].includes(command)) {
      return response.send({ status: 'error', message: 'Invalid command. Use "add" or "remove"' });
    }
    const ownerUsername = request.body.ownerUsername;
    const ownerId = request.body.ownerId;
    if (!ownerId && !ownerUsername) {
      return response.send({ status: 'error', message: 'No owner _id or username given' });
    }
    if (ownerId && !ownerUsername && !ObjectId.isValid(ownerId)) {
      return response.send({ status: 'error', message: 'Incorrect owner _id given' });
    }
    const entityId = request.body.entityId;
    if (!entityId || !ObjectId.isValid(entityId)
      || await Mongo.resolve(entityId, 'entity') === undefined) {
      return response.send({ status: 'error', message: 'Invalid entity identifier' });
    }
    const AccDB = Mongo.getAccountsRepository();
    const ldap = AccDB.collection<ILDAPData>('users');
    const findUserQuery = (ownerId) ? { _id: new ObjectId(ownerId) } : { username: ownerUsername };
    const account = await ldap.findOne(findUserQuery);
    if (!account) {
      return response.send({ status: 'error', message: 'Incorrect owner _id or username given' });
    }

    account.data.entity = (account.data.entity) ? account.data.entity : [];
    account.data.entity = account.data.entity.filter(entity => entity);

    switch (command) {
      case 'add':
        if (!(account.data.entity as IEntity[])
          .find(obj => obj.toString() === entityId.toString())) {
          account.data.entity.push(new ObjectId(entityId));
        }
        break;
      case 'remove':
        const entityUses = (await Utility.findAllEntityOwners(entityId)).length;
        if (entityUses === 1) {
          return response.send({ status: 'error', message: 'Cannot remove last owner' });
        }
        account.data.entity = (account.data.entity as IEntity[])
          .filter(entity => entity.toString() !== entityId.toString());
        break;
      default:
    }

    const updateResult = await ldap.updateOne(
      findUserQuery,
      { $set: { data: account.data } });

    if (updateResult.result.ok !== 1) {
      return response.send({ status: 'error', message: 'Failed updating entity array' });
    }

    return response.send({ status: 'ok' });
  },
};

export { Utility };
