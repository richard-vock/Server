import { ObjectId } from 'mongodb';
import { Request, Response } from 'express';

import { RepoCache } from '../cache';
import { Logger } from '../logger';
import {
  ICompilation,
  IEntity,
  IUserData,
  IMetaDataDigitalEntity,
  isAnnotation,
  isCompilation,
  isDigitalEntity,
  isEntity,
  isPerson,
  isInstitution,
} from '../../common/interfaces';
import {
  resolveCompilation,
  resolveDigitalEntity,
  resolveEntity,
  resolvePerson,
  resolveInstitution,
} from './resolving-strategies';
import {
  saveAnnotation,
  saveCompilation,
  saveDigitalEntity,
  saveEntity,
  savePerson,
  saveInstitution,
} from './saving-strategies';

import { query, updatePreviewImage } from './functions';
import Users from './users';
import { Repo } from './controllers';
// import DBClient from './client';

interface IExploreRequest {
  searchEntity: boolean;
  types: string[];
  filters: {
    annotatable: boolean;
    annotated: boolean;
    restricted: boolean;
    associated: boolean;
  };
  searchText: string;
  offset: number;
}

interface IEntityRequestParams {
  identifier: string;
  collection: string;
  password?: string;
}

/**
 * DEPRECATED: Redirects to correct function though!
 * When the user submits the metadataform this function
 * adds the missing data to defined collections
 */
const submit = async (req: Request<IEntityRequestParams>, res: Response) => {
  Logger.info('Handling submit req');
  req.params.collection = 'digitalentity';
  await addEntityToCollection(req, res);
};

// TODO: Typesafe collectionName with validation
const addEntityToCollection = async (req: Request<IEntityRequestParams>, res: Response) => {
  RepoCache.flush();

  const {
    userData,
    doesEntityExist,
    isValidObjectId,
    collectionName: coll,
  } = (req as any).data as {
    userData: IUserData;
    doesEntityExist: boolean;
    isValidObjectId: boolean;
    collectionName: string;
  };

  let entity = req.body;
  const _id = isValidObjectId ? new ObjectId(entity._id) : new ObjectId();
  entity._id = _id;

  let savingPromise: Promise<any> | undefined;
  switch (true) {
    case isCompilation(entity):
      savingPromise = saveCompilation(entity, userData);
      break;
    case isEntity(entity):
      savingPromise = saveEntity(entity, userData);
      break;
    case isAnnotation(entity):
      savingPromise = saveAnnotation(entity, userData, doesEntityExist);
      break;
    case isPerson(entity):
      savingPromise = savePerson(entity, userData);
      break;
    case isInstitution(entity):
      savingPromise = saveInstitution(entity, userData);
      break;
    case isDigitalEntity(entity):
      savingPromise = saveDigitalEntity(entity, userData);
      break;
    default:
      await Users.makeOwnerOf(req, _id, coll);
      break;
  }
  await savingPromise
    ?.then(async res => {
      entity = res;
      if (isDigitalEntity(entity)) await Users.makeOwnerOf(req, entity._id, 'digitalentity');
    })
    .catch(err => Logger.err(err) && res.status(500).send(err));

  // We already got rejected. Don't update entity in DB
  if (res.headersSent) return undefined;

  const updateResult = await Repo.get(coll).updateOne({ _id }, { $set: entity }, { upsert: true });

  if (!updateResult) {
    Logger.err(`Failed updating ${coll} ${_id}`);
    return res.status(500).send(`Failed updating ${coll} ${_id}`);
  }

  const resultId = updateResult.upsertedId ?? _id;
  Logger.info(`Success! Updated ${coll} ${_id}`);
  return res.status(200).send(await resolve<any>(resultId, coll));
};

const updateEntitySettings = async (req: Request<IEntityRequestParams>, res: Response) => {
  const preview = req.body.preview;
  const identifier = ObjectId.isValid(req.params.identifier)
    ? new ObjectId(req.params.identifier)
    : req.params.identifier;

  // Save preview to file, if not yet done
  const finalImagePath = await updatePreviewImage(preview, 'entity', identifier);

  // Overwrite old settings
  const settings = { ...req.body, preview: finalImagePath };
  const result = await Repo.entity.updateOne({ _id: identifier }, { $set: { settings } });

  if (!result) return res.status(500).send('Failed updating settings');

  return res.status(200).send(settings);
};

const resolve = async <T>(obj: any, coll: string, depth?: number) => {
  if (!obj) return undefined;
  const parsedId = (obj['_id'] ? obj['_id'] : obj).toString();
  if (!ObjectId.isValid(parsedId)) return undefined;
  const _id = new ObjectId(parsedId);

  const temp = await RepoCache.get<T>(parsedId);
  if (temp) {
    // Make sure returned object is valid and not {}
    if ((temp as any)._id) {
      return temp as T;
    }
    // Flush invalid object from cache
    RepoCache.del(parsedId).then(numDelKeys => {
      if (numDelKeys > 0) Logger.info(`Deleted ${parsedId} from ${coll} cache`);
    });
  }

  return Repo.get<T>(coll)
    .findOne(query(_id))
    .then(async resolve_result => {
      if (depth && depth === 0) return resolve_result;

      if (isDigitalEntity(resolve_result)) return resolveDigitalEntity(resolve_result);

      if (isEntity(resolve_result)) return resolveEntity(resolve_result);

      if (isCompilation(resolve_result)) return resolveCompilation(resolve_result);

      if (isPerson(resolve_result)) return resolvePerson(resolve_result);

      if (isInstitution(resolve_result)) return resolveInstitution(resolve_result);

      return resolve_result;
    })
    .then(async result => {
      if (result) await RepoCache.set(parsedId, result);
      return result as unknown as T | null;
    })
    .catch(err => {
      Logger.warn(`Encountered error trying to resolve ${parsedId} in ${coll}`);
      Logger.err(err);
      return undefined;
    });
};

const getEntityFromCollection = async (req: Request<IEntityRequestParams>, res: Response) => {
  const RequestCollection = req.params.collection.toLowerCase();

  const _id = ObjectId.isValid(req.params.identifier)
    ? new ObjectId(req.params.identifier)
    : req.params.identifier;
  const password = req.params.password ? req.params.password : '';
  const entity = await resolve<any>(_id, RequestCollection);
  if (!entity) return res.status(404).send(`No ${RequestCollection} found with given identifier`);

  if (isCompilation(entity)) {
    const compilation = entity;
    const _pw = compilation.password;
    const isPasswordProtected = _pw && _pw !== '';
    const isUserOwner = await Users.isOwner(req, _id);
    const isPasswordCorrect = _pw && _pw === password;

    if (!isPasswordProtected || isUserOwner || isPasswordCorrect)
      return res.status(200).send(compilation);

    return res.status(200).end();
  }
  return res.status(200).send(entity);
};

const getAllEntitiesFromCollection = async (req: Request<IEntityRequestParams>, res: Response) => {
  const coll = req.params.collection.toLowerCase();
  const allowed = ['person', 'institution', 'tag'];
  if (!allowed.includes(coll)) return res.status(200).send([]);

  const docs = await Repo.get(coll).findAll();
  const resolved = await Promise.all(docs.map(doc => resolve<any>(doc, coll)));
  return res.status(200).send(resolved.filter(_ => _));
};

const removeEntityFromCollection = async (req: Request<IEntityRequestParams>, res: Response) => {
  const coll = req.params.collection.toLowerCase();

  const _id = ObjectId.isValid(req.params.identifier)
    ? new ObjectId(req.params.identifier).toString()
    : req.params.identifier;

  const user = await Users.getBySession(req);
  if (!user) return res.status(404).send('User not found');

  if (req.body?.username !== user?.username) {
    Logger.err('Entity removal failed due to username & session not matching');
    return res.status(403).send('Input username does not match username with current sessionID');
  }

  // Flatten account.data so its an array of ObjectId.toString()
  const UserRelatedEntities = Array.prototype
    .concat(...Object.values(user.data))
    .map(id => id.toString());

  if (!UserRelatedEntities.find(obj => obj === _id)) {
    const message = 'Entity removal failed because Entity does not belong to user';
    Logger.err(message);
    return res.status(401).send(message);
  }

  const deleteResult = await Repo.get(coll).deleteOne(query(_id));
  if (!deleteResult) {
    const message = `Failed deleting ${coll} ${req.params.identifier}`;
    Logger.warn(message);
    return res.status(500).send(message);
  }

  // Delete from User
  if (!(await Users.undoOwnerOf(user, _id, coll))) {
    const message = `Failed removing owner of ${coll} ${req.params.identifier}`;
    Logger.warn(message);
    return res.status(500).send(message);
  }

  const message = `Deleted ${coll} ${req.params.identifier}`;
  Logger.info(message);
  res.status(200).send(message);

  return RepoCache.flush();
};

const searchByEntityFilter = async (req: Request<IEntityRequestParams>, res: Response) => {
  const coll = req.params.collection.toLowerCase();
  const body: any = req.body ? req.body : {};
  const filter: any = body.filter ? body.filter : {};

  const doesEntityPropertyMatch = (obj: any, propName: string, _filter = filter) => {
    if (obj[propName] === null || obj[propName] === undefined) return false;
    switch (typeof obj[propName]) {
      case 'string':
        if (obj[propName].indexOf(_filter[propName]) === -1) return false;
        break;
      case 'object':
        switch (typeof _filter[propName]) {
          case 'string':
            // Case: search for string inside of entity
            if (JSON.stringify(obj[propName]).indexOf(_filter[propName]) === -1) return false;
            break;
          case 'object':
            // Case: recursive search inside of entity + array of entities
            for (const prop in _filter[propName]) {
              if (Array.isArray(obj[propName])) {
                let resultInArray = false;
                for (const innerObj of obj[propName]) {
                  if (doesEntityPropertyMatch(innerObj, prop, _filter[propName])) {
                    resultInArray = true;
                  }
                }
                if (!resultInArray) return false;
              } else {
                if (!doesEntityPropertyMatch(obj[propName], prop, _filter[propName])) {
                  return false;
                }
              }
            }
            break;
          default:
            if (obj[propName] !== _filter[propName]) return false;
        }
        break;
      default:
        if (obj[propName] !== _filter[propName]) return false;
    }
    return true;
  };

  const docs = await Repo.get(coll).findAll();
  const resolved = await Promise.all(docs.map(doc => resolve<any>(doc, coll)));
  const filtered = resolved.filter(obj => {
    for (const prop in filter) {
      if (!doesEntityPropertyMatch(obj, prop)) return false;
    }
    return true;
  });

  return res.status(200).send(filtered);
};

const searchByTextFilter = async (req: Request<IEntityRequestParams>, res: Response) => {
  const coll = req.params.collection.toLowerCase();

  const filter = req.body.filter ? req.body.filter.map((_: any) => _.toLowerCase()) : [''];
  const offset = req.body.offset ? parseInt(req.body.offset, 10) : 0;
  const length = 20;

  if (typeof offset !== 'number') return res.status(400).send('Offset is not a number');

  if (offset < 0) return res.status(400).send('Offset is smaller than 0');

  const docs = (await Repo.get(coll).findAll()).slice(offset, offset + length);
  const resolved = await Promise.all(docs.map(doc => resolve<any>(doc, coll)));

  const getNestedValues = (obj: any) => {
    let result: string[] = [];
    for (const key of Object.keys(obj)) {
      const prop = obj[key];
      if (!prop) continue;
      if (typeof prop === 'object' && !Array.isArray(prop)) {
        result = result.concat(getNestedValues(prop));
      } else if (typeof prop === 'object' && Array.isArray(prop)) {
        for (const p of prop) {
          result = result.concat(getNestedValues(p));
        }
      } else if (typeof prop === 'string') {
        result.push(prop);
      }
    }
    return result;
  };

  const filterResults = (objs: any[]) => {
    const result: any[] = [];
    for (const obj of objs) {
      const asText = getNestedValues(obj).join('').toLowerCase();
      for (let j = 0; j < filter.length; j++) {
        if (asText.indexOf(filter[j]) === -1) {
          break;
        }
        if (j === filter.length - 1) {
          result.push(obj);
        }
      }
    }
    return result;
  };

  return res.status(200).send(filterResults(resolved));
};

const explore = async (req: Request<any, IExploreRequest>, res: Response) => {
  const { types, offset, searchEntity, filters, searchText } = req.body;
  const items = new Array<IEntity | ICompilation>();
  const limit = 30;
  const userData = await Users.getBySession(req);
  const userOwned = userData ? JSON.stringify(userData.data) : '';

  // Check if req is cached
  const reqHash = RepoCache.hash(req.body);
  const temp = await RepoCache.get<IEntity[] | ICompilation[]>(reqHash);

  if (temp && temp?.length > 0) {
    items.push(...temp);
  } else if (searchEntity) {
    const cursor = Repo.entity
      .findCursor({
        finished: true,
        online: true,
        mediaType: {
          $in: types,
        },
      })
      .sort({
        name: 1,
      })
      .skip(offset);

    const entities: IEntity[] = [];

    const canContinue = async () =>
      (await cursor.hasNext()) && entities.length < limit && types.length > 0;

    while (await canContinue()) {
      const _entity = await cursor.next();
      if (!_entity || !_entity._id) continue;
      const resolved = await resolve<IEntity>(_entity, 'entity');
      if (!resolved) continue;

      const isOwner = userOwned.includes(resolved._id.toString());
      const metadata = JSON.stringify(resolved).toLowerCase();

      const isAnnotatable = isOwner; // only owner can set default annotations
      if (filters.annotatable && !isAnnotatable) continue;

      const isAnnotated = Object.keys(resolved.annotations).length > 0;
      if (filters.annotated && !isAnnotated) continue;

      let isRestricted = false;
      // Whitelist visibility filter
      if (resolved.whitelist.enabled) {
        if (!userData) continue;
        // TODO: manual checking instead of JSON.stringify
        const isWhitelisted = JSON.stringify(resolved.whitelist).includes(userData._id.toString());
        if (!isOwner && !isWhitelisted) continue;
        isRestricted = true;
      }
      if (filters.restricted && !isRestricted) continue;

      const isAssociated = userData // user appears in metadata
        ? metadata.includes(userData.fullname.toLowerCase()) ||
          metadata.includes(userData.mail.toLowerCase())
        : false;
      if (filters.associated && !isAssociated) continue;

      // Search text filter
      if (searchText !== '' && !metadata.includes(searchText)) {
        continue;
      }

      const { description, licence } = resolved.relatedDigitalEntity as IMetaDataDigitalEntity;
      entities.push({
        ...resolved,
        relatedDigitalEntity: {
          description,
          licence,
        } as IMetaDataDigitalEntity,
      } as IEntity);
    }

    items.push(...entities);
  } else {
    const cursor = Repo.compilation
      .findCursor({})
      .sort({
        name: 1,
      })
      .skip(offset);
    const compilations: ICompilation[] = [];

    const canContinue = async () =>
      (await cursor.hasNext()) && !cursor.closed && compilations.length < limit && types.length > 0;

    while (await canContinue()) {
      const _comp = await cursor.next();
      if (!_comp) continue;
      const resolved = await resolve<ICompilation>(_comp, 'compilation');

      if (!resolved || !resolved._id) continue;
      if (Object.keys(resolved.entities).length === 0) continue;

      if (searchText !== '') {
        if (
          !resolved.name.toLowerCase().includes(searchText) &&
          !resolved.description.toLowerCase().includes(searchText)
        ) {
          continue;
        }
      }

      const isOwner = userOwned.includes(resolved._id.toString());

      const isPWProtected = resolved.password !== undefined && resolved.password !== '';

      // owner can always annotate
      // otherwise only logged in and only if included in whitelist
      const isWhitelisted =
        resolved.whitelist.enabled &&
        userData &&
        JSON.stringify(resolved.whitelist).includes(userData._id.toString());
      const isAnnotatable = isOwner ? true : isWhitelisted;
      if (filters.annotatable && !isAnnotatable) continue;

      if (isPWProtected && !isOwner && !isAnnotatable) continue;
      if (filters.restricted && isPWProtected) continue;

      const isAnnotated = Object.keys(resolved.annotations).length > 0;
      if (filters.annotated && !isAnnotated) continue;

      for (const id in resolved.entities) {
        const value = resolved.entities[id];
        if (!isEntity(value)) {
          delete resolved.entities[id];
          continue;
        }
        const { mediaType, name, settings } = value;
        resolved.entities[id] = { mediaType, name, settings } as IEntity;
      }
      for (const id in resolved.annotations) {
        const value = resolved.annotations[id];
        if (!isAnnotation(value)) {
          delete resolved.annotations[id];
          continue;
        }
        resolved.annotations[id] = { _id: value._id };
      }

      compilations.push({
        ...resolved,
        password: isPWProtected,
      });
    }

    items.push(...compilations);
  }

  res.status(200).send(items.sort((a, b) => a.name.localeCompare(b.name)));

  // Cache full req
  RepoCache.set(reqHash, items);
};

const test = async (req: Request<IEntityRequestParams>, res: Response) => {
  const coll = req.params.collection.toLowerCase();
  const docs = await Repo.get(coll).findAll();

  const maxRand = 5;
  const randIndex = Math.floor(Math.random() * (docs.length - maxRand));

  const resolved = await Promise.all(
    docs.slice(randIndex, randIndex + maxRand).map(doc => resolve<any>(doc, coll)),
  );
  const filtered = resolved.filter(_ => _);

  return res.status(200).send(filtered.slice(0, 5));
  return res.status(200).send({});
};

export const Entities = {
  submit,
  addEntityToCollection,
  updateEntitySettings,
  resolve,
  getEntityFromCollection,
  getAllEntitiesFromCollection,
  removeEntityFromCollection,
  searchByEntityFilter,
  searchByTextFilter,
  explore,
  test,
};

export default Entities;
