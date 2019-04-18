import { Collection, Db, ObjectId } from 'mongodb';

import { Mongo } from './mongo';

const Utility = {
  findAllModelOwners: async (request, response) => {
    const modelId = request.params.identifier;
    if (!ObjectId.isValid(modelId)) {
      response.send({ status: 'error', message: 'Invalid model _id ' });
      return;
    }

    const AccDB: Db = await Mongo.getAccountsRepository();
    const ldap: Collection = AccDB.collection('ldap');
    const accounts = (await ldap.find({})
      .toArray())
      .filter(userData => {
        const Models = JSON.stringify(userData.data.model);
        return Models.indexOf(modelId) !== -1;
      })
      .map(userData => ({
        fullname: userData.fullname,
        username: userData.username,
        _id: userData._id,
      }));
    response.send({ status: 'ok', accounts });
  },
  countModelUses: async (request, response) => {
    const modelId = request.params.identifier;
    if (!ObjectId.isValid(modelId)) {
      response.send({ status: 'error', message: 'Invalid model _id ' });
      return;
    }

    const ObjDB: Db = await Mongo.getObjectsRepository();
    const compilations = (await ObjDB.collection('compilation')
      .find({})
      .toArray())
      .filter(comp => {
        const Models = JSON.stringify(comp.models);
        return Models.indexOf(modelId) !== -1;
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
    const validAnnotations = annotations
      .filter(ann => ObjectId.isValid(ann))
      .filter(async ann => await Mongo.resolve(ann, 'annotation') !== undefined);

    const compId = request.params.identifier;
    if (!compId || !ObjectId.isValid(compId)
      || await Mongo.resolve(compId, 'compilation') === undefined) {
      response.send({ status: 'error', message: 'Invalid compilation given' });
      return;
    }

    const ObjDB: Db = await Mongo.getObjectsRepository();
    const CompColl = ObjDB.collection('compilation');
    const compilation = await CompColl.findOne({ _id: new ObjectId(compId) });
    if (!compilation) {
      response.send({ status: 'error', message: 'Compilation not found' });
      return;
    }

    compilation['annotationList'] = (compilation['annotationList'])
      ? compilation['annotationList'] : [];
    compilation['annotationList'] = Array.from(new Set(
      compilation['annotationList'].concat(validAnnotations).map(ann => new ObjectId(ann))
    ));

    const updateResult = await CompColl
      .updateOne(
        { _id: new ObjectId(compId) },
        { $set: { annotationList: compilation['annotationList'] } });
    if (updateResult.result.ok !== 1) {
      response.send({ status: 'error', message: 'Failed updating annotationList' });
      return;
    }
    response.send({ status: 'ok', ...await Mongo.resolve(compId, 'compilation') });
  },
  applyActionToModelOwner: async (request, response) => {
    const command = request.body.command;
    if (!['add', 'remove'].includes(command)) {
      response.send({ status: 'error', message: 'Invalid command. Use "add" or "remove"' });
      return;
    }
    const ownerId = request.body.ownerId;
    if (!ownerId || !ObjectId.isValid(ownerId)) {
      response.send({ status: 'error', message: 'Invalid LDAP identifier' });
      return;
    }
    const modelId = request.body.modelId;
    if (!modelId || !ObjectId.isValid(modelId)
      || await Mongo.resolve(modelId, 'model') === undefined) {
      response.send({ status: 'error', message: 'Invalid model identifier' });
      return;
    }
    const AccDB: Db = Mongo.getAccountsRepository();
    const ldap = await AccDB.collection('ldap');
    const account = await ldap.findOne({ _id: new ObjectId(ownerId) });
    if (!account) {
      response.send({ status: 'error', message: 'Invalid LDAP identifier' });
      return;
    }

    account.data.model = (account.data.model) ? account.data.model : [];

    switch (command) {
      case 'add':
        if (!account.data.model.find(obj => obj.toString() === modelId.toString())) {
          account.data.model.push(new ObjectId(modelId));
        }
        break;
      case 'remove':
        account.data.model = account.data.model
          .filter(model => model.toString() !== modelId.toString());
        break;
      default:
    }

    const updateResult = await ldap.updateOne(
      { _id: new ObjectId(ownerId) },
      { $set: { data: account.data } });

    if (updateResult.result.ok !== 1) {
      response.send({ status: 'error', message: 'Failed updating model array' });
      return;
    }

    response.send({ status: 'ok' });
  },
};

export { Utility };
