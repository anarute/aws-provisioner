'use strict';
let debug = require('debug')('routes:v1');
let base = require('taskcluster-base');
let taskcluster = require('taskcluster-client');
let _ = require('lodash');

// Common schema prefix
let SCHEMA_PREFIX_CONST = 'http://schemas.taskcluster.net/aws-provisioner/v1/';

/**
 * API end-point for version v1/
 *
 * In this API implementation we shall assume the following context:
 * {
 *   publisher:         // Publisher created with exchanges.js
 *   WorkerType:        // Instance of data.WorkerType
 * }
 */
let api = new base.API({
  title: 'AWS Provisioner API Documentation',
  description: [
    'The AWS Provisioner is responsible for provisioning instances on EC2 for use in',
    'TaskCluster.  The provisioner maintains a set of worker configurations which',
    'can be managed with an API that is typically available at',
    'aws-provisioner.taskcluster.net.  This API can also perform basic instance',
    'management tasks in addition to maintaining the internal state of worker type',
    'configuration information.',
    '',
    'The Provisioner runs at a configurable interval.  Each iteration of the',
    'provisioner fetches a current copy the state that the AWS EC2 api reports.  In',
    'each iteration, we ask the Queue how many tasks are pending for that worker',
    'type.  Based on the number of tasks pending and the scaling ratio, we may',
    'submit requests for new instances.  We use pricing information, capacity and',
    'utility factor information to decide which instance type in which region would',
    'be the optimal configuration.',
    '',
    'Each EC2 instance type will declare a capacity and utility factor.  Capacity is',
    'the number of tasks that a given machine is capable of running concurrently.',
    'Utility factor is a relative measure of performance between two instance types.',
    'We multiply the utility factor by the spot price to compare instance types and',
    'regions when making the bidding choices.',
    '',
  ].join('\n'),
});

module.exports = api;

api.declare({
  method: 'put',
  route: '/worker-type/:workerType',
  name: 'createWorkerType',
  deferAuth: true,
  scopes: ['aws-provisioner:manage-worker-type:<workerType>'],
  input: SCHEMA_PREFIX_CONST + 'create-worker-type-request.json#',
  output: SCHEMA_PREFIX_CONST + 'get-worker-type-response.json#',
  title: 'Create new Worker Type',
  description: [
    'Create a worker type and ensure that all EC2 regions have the required',
    'KeyPair',
  ].join('\n'),
}, async function (req, res) {
  let input = req.body;
  let workerType = req.params.workerType;

  input.lastModified = new Date();

  // Authenticate request with parameterized scope
  if (!req.satisfies({workerType: workerType})) {
    return;
  }

  // TODO: If workerType launchSpecification specifies scopes that should be given
  //       to the workers using temporary credentials, then you should validate
  //       that the caller has this scopes to avoid scope elevation.

  // We want to make sure that every single possible generated LaunchSpec
  // would be valid before we even try to store it
  try {
    this.WorkerType.testLaunchSpecs(input, this.keyPrefix, this.provisionerId, this.provisionerBaseUrl);
  } catch (err) {
    // We handle invalid launch spec errors
    if (err && err.code !== 'InvalidLaunchSpecifications') {
      throw err;
    }
    debug('InvalidLaunchSpecifications!');
    if (err.reasons) {
      for (let reason of err.reasons) {
        debug(reason);
      }
    }
    res.status(400).json({
      message: 'Invalid launchSpecification',
      error: {
        reasons: err.reasons,
      },
    });
    return;
  }

  // Create workerType
  let wType;
  try {
    wType = await this.WorkerType.create(workerType, input);
  } catch (err) {
    // We only catch EntityAlreadyExists errors
    if (!err || err.code !== 'EntityAlreadyExists') {
      throw err;
    }
    wType = await this.WorkerType.load({workerType});

    // Check the it matches the existing workerType
    let match = [
      'launchSpec',
      'userData',
      'secrets',
      'scopes',
      'minCapacity',
      'maxCapacity',
      'scalingRatio',
      'minPrice',
      'maxPrice',
      'canUseOndemand',
      'canUseSpot',
      'instanceTypes',
      'regions',
    ].every((key) => {
      return _.isEqual(wType[key], input[key]);
    });

    // If we don't have a match we return 409, otherwise we continue as this is
    // is an idempotent operation.
    if (!match) {
      res.status(409).json({
        error: 'WorkerType already exists with different definition',
      });
      return;
    }
  }

  // Publish pulse message
  await this.publisher.workerTypeCreated({
    workerType: workerType,
  });

  let workerjson = wType.json();
  delete workerjson.canUseOnDemand;
  workerjson.canUseOndemand = false;
  res.reply(workerjson);
  return;
});

api.declare({
  method: 'post',
  route: '/worker-type/:workerType/update',
  name: 'updateWorkerType',
  deferAuth: true,
  // Shouldn't we just have a single scope for modifying/creating/deleting workerTypes
  scopes: ['aws-provisioner:manage-worker-type:<workerType>'],
  input: SCHEMA_PREFIX_CONST + 'create-worker-type-request.json#',
  output: SCHEMA_PREFIX_CONST + 'get-worker-type-response.json#',
  title: 'Update Worker Type',
  description: [
    'Update a workerType and ensure that all regions have the require',
    'KeyPair',
  ].join('\n'),
}, async function (req, res) {
  let input = req.body;
  let workerType = req.params.workerType;

  let modDate = new Date();

  input.lastModified = modDate;

  if (!req.satisfies({workerType: workerType})) { return undefined; }

  try {
    this.WorkerType.testLaunchSpecs(input, this.keyPrefix, this.provisionerId, this.provisionerBaseUrl);
  } catch (err) {
    // We handle invalid launch spec errors
    if (err && err.code !== 'InvalidLaunchSpecifications') {
      throw err;
    }
    debug('InvalidLaunchSpecifications!');
    if (err.reasons) {
      for (let reason of err.reasons) {
        debug(reason);
      }
    }
    return res.status(400).json({
      message: 'Invalid launchSpecification',
      error: {
        reasons: err.reasons,
      },
    });
  }

  let wType = await this.WorkerType.load({workerType: workerType});

  await wType.modify(function (w) {
    // We know that data that gets to here is valid per-schema
    for (let key of Object.keys(input)) {
      w[key] = input[key];
      w.lastModified = modDate;
    }
  });

  // Publish pulse message
  await this.publisher.workerTypeUpdated({
    workerType: workerType,
  });

  return res.reply(wType.json());
});

api.declare({
  method: 'get',
  route: '/worker-type/:workerType',
  name: 'workerType',
  deferAuth: true,
  scopes: [
    'aws-provisioner:view-worker-type:<workerType>',
    'aws-provisioner:manage-worker-type:<workerType>',
  ],
  input: undefined,  // No input
  output: SCHEMA_PREFIX_CONST + 'get-worker-type-response.json#',
  title: 'Get Worker Type',
  description: [
    'Retreive a WorkerType definition',
  ].join('\n'),
}, async function (req, res) {
  let workerType = req.params.workerType;

  if (!req.satisfies({workerType: workerType})) { return undefined; }

  let worker;
  try {
    worker = await this.WorkerType.load({workerType: workerType});

    // We do this because John made a mistake in the V1->V2
    // schema update and there was a typo :(
    let workerjson = worker.json();
    workerjson.canUseOndemand = false;
    delete workerjson.canUseOnDemand;

    return res.reply(workerjson);
  } catch (err) {
    if (err.code === 'ResourceNotFound') {
      res.status(404).json({
        error: err.code,
        msg: workerType + ' not found',
      });
    } else {
      throw err;
    }
  }
});

api.declare({
  method: 'delete',
  route: '/worker-type/:workerType',
  name: 'removeWorkerType',
  deferAuth: true,
  // TODO: Should we have a special scope for workertype removal?
  scopes: ['aws-provisioner:manage-worker-type:<workerType>'],
  input: undefined,  // No input
  output: undefined,  // No output
  title: 'Delete Worker Type',
  description: [
    'Delete a WorkerType definition, submits requests to kill all ',
    'instances and delete the KeyPair from all configured EC2 regions',
  ].join('\n'),
}, async function (req, res) {
  let that = this;
  let workerType = req.params.workerType;

  if (!req.satisfies({workerType: workerType})) { return undefined; }

  try {
    await this.WorkerType.remove({workerType: workerType}, true);
    await that.publisher.workerTypeRemoved({
      workerType: workerType,
    });
    res.status(204).end();
  } catch (err) {
    if (err.code === 'ResourceNotFound') {
      res.status(204).end();
    } else {
      debug('unknown error deleting ' + workerType);
      debug(err);
      if (err.stack) {
        debug(err.stack);
      }
      throw err;
    }
  }
});

api.declare({
  method: 'get',
  route: '/list-worker-types',
  name: 'listWorkerTypes',
  scopes: [
      'aws-provisioner:list-worker-types',
  ],
  input: undefined,  // No input
  output: SCHEMA_PREFIX_CONST + 'list-worker-types-response.json#',
  title: 'List Worker Types',
  description: [
    'List all known WorkerType names',
  ].join('\n'),
}, async function (req, res) {

  try {
    let list = await this.WorkerType.listWorkerTypes();
    return res.reply(list);
  } catch (err) {
    debug('error listing workertypes');
    debug(err);
    if (err.stack) {
      debug(err.stack);
    }
    throw err;
  }
});

api.declare({
  method: 'put',
  route: '/secret/:token',
  name: 'createSecret',
  scopes: ['aws-provisioner:create-secret'],
  input: SCHEMA_PREFIX_CONST + 'create-secret-request.json#',
  title: 'Create new Secret',
  description: [
    'Insert a secret into the secret storage.  This should not',
    'normally be done through this API, but is provided for testing',
    'and completeness',
  ].join('\n'),
}, async function (req, res) {
  let input = req.body;
  let token = req.params.token;

  let secret;
  try {
    secret = await this.Secret.create({
      token: token,
      workerType: input.workerType,
      secrets: input.secrets,
      scopes: input.scopes,
      expiration: new Date(input.expiration),
    });
  } catch (err) {
    if (err.code !== 'EntityAlreadyExists') {
      throw err;
    }

    secret = await this.Secret.load({
      token: token,
      provisionerId: this.provisionerId,
    });

    let match = [
      'workerType',
      'secrets',
      'token',
      'scopes',
      //'expiration' weird stuff is happening here.  going to assume that
      // we should probably do some sort of Date.toISOString() comparison or something
    ].every((key) => {
      return _.isEqual(secret[key], input[key]);
    });

    // If we don't have a match we return 409, otherwise we continue as this is
    // is an idempotent operation.
    if (!match) {
      res.status(409).json({
        error: 'Secret already exists with different definition',
      });
      return;
    }
  }

  res.reply({outcome: 'success'});
  return;
});

api.declare({
  method: 'get',
  route: '/secret/:token',
  name: 'getSecret',
  output: SCHEMA_PREFIX_CONST + 'get-secret-response.json#',
  title: 'Get a Secret',
  description: [
    'Retreive a secret from storage.  It is important that this secret is',
    'deleted by the consumer, or else the secrets will be visible to any',
    'process which can read HTTP on the worker localhost interface.',
  ].join('\n'),
}, async function (req, res) {
  let token = req.params.token;

  try {
    let secret = await this.Secret.load({
      token: token,
    });

    return res.reply({
      data: secret.secrets,
      scopes: secret.scopes,
      credentials: taskcluster.createTemporaryCredentials({
        scopes: secret.scopes,
        expiry: taskcluster.fromNow('96 hours'),
        credentials: this.credentials,
      }),
    });
  } catch (err) {
    if (err.code === 'ResourceNotFound') {
      res.status(404).end();
    } else {
      debug('error getting secret ' + token);
      debug(err);
      if (err.stack) {
        debug(err.stack);
      }
      throw err;
    }
  }
});

api.declare({
  method: 'get',
  route: '/instance-started/:instanceId/:token',
  name: 'instanceStarted',
  title: 'Report an instance starting',
  description: [
    'An instance will report in by giving its instance id as well',
    'as its security token.  The token is given and checked to ensure',
    'that it matches a real token that exists to ensure that random',
    'machines do not check in.  We could generate a different token',
    'but that seems like overkill',
  ].join('\n'),
}, async function (req, res) {
  let instanceId = req.params.instanceId;
  let token = req.params.token;

  try {
    await this.Secret.load({
      token: token,
    });

    this.reportInstanceStarted({
      id: instanceId,
    });

    return res.status(204).end();
  } catch (err) {
    debug('error reporting instance %s start with token %s', instanceId, token);
    debug(err);
    if (err.stack) {
      debug(err.stack);
    }
    throw err;
  }
});

api.declare({
  method: 'delete',
  route: '/secret/:token',
  name: 'removeSecret',
  title: 'Remove a Secret',
  description: [
    'Remove a secret.  It is very important that the consumer of a ',
    'secret delete the secret from storage before handing over control',
    'to another process or else it could read the HTTP UserData endpoint',
    'and use the getSecrete() api here to get the secrets',
  ].join('\n'),
}, async function (req, res) {
  let token = req.params.token;

  try {
    await this.Secret.remove({
      token: token,
    }, true);
    res.status(204).end();
  } catch (err) {
    if (err.code === 'ResourceNotFound') {
      res.status(204).end();
    } else {
      debug('error removing a secret');
      debug(err);
      if (err.stack) {
        debug(err.stack);
      }
      throw err;
    }
  }
});

/** Utility methods below */

api.declare({
  method: 'get',
  route: '/worker-type/:workerType/launch-specifications',
  name: 'getLaunchSpecs',
  deferAuth: true,
  scopes: [
    'aws-provisioner:view-worker-type:<workerType>',
    'aws-provisioner:manage-worker-type:<workerType>',
  ],
  input: undefined,  // No input
  output: SCHEMA_PREFIX_CONST + 'get-launch-specs-response.json#',
  title: 'Get All Launch Specifications for WorkerType',
  description: [
    'Return the EC2 LaunchSpecifications for all combinations of regions',
    'and instance types or a list of reasons why the launch specifications',
    'are not valid',
    '',
    '**This API end-point is experimental and may be subject to change without warning.**',
  ].join('\n'),
}, async function (req, res) {
  let workerType = req.params.workerType;

  if (!req.satisfies({workerType: workerType})) { return undefined; }

  let worker = await this.WorkerType.load({workerType: workerType});
  let outcome;
  try {
    outcome = worker.testLaunchSpecs();
  } catch (err) {
    outcome = [];
    if (err.reasons) {
      for (let e of err.reasons) {
        console.error(e, e.stack);
        outcome.push({error: e, stack: e.stack});
      }
    }
  } finally {
    return res.reply(outcome);
  }
});

api.declare({
  method: 'get',
  route: '/aws-state',
  name: 'awsState',
  title: 'Get AWS State for all worker types',
  scopes: ['aws-provisioner:aws-state'],
  description: [
    'DEPRECATED.',
  ].join('\n'),
}, async function (req, res) {
  let state = {};
  try {
    let workers = await this.WorkerType.listWorkerTypes();
    for (let worker of workers) {
      try {
        let workerState = await this.WorkerState.load({workerType: worker});
        state[worker] = {
          running: workerState.instances.filter(i => i.state === 'running'),
          pending: workerState.instances.filter(i => i.state === 'pending'),
          spotReq: workerState.requests,
        }
      } catch (err) {
        state[worker] = {
          running: [],
          pending: [],
          spotReq: [],
        }
        debug('error loading state for ' + worker);
        debug(err);
        if (err.stack) {
          debug(err.stack);
        }
      }
    }
    res.reply(state);
  } catch (err) {
    debug('error listing worker types');
    debug(err);
    if (err.stack) {
      debug(err.stack);
    }
    throw err;
  }
});

api.declare({
  method: 'get',
  route: '/state/:workerType',
  name: 'state',
  title: 'Get AWS State for a worker type',
  scopes: ['aws-provisioner:view-worker-type:<workerType>'],
  description: [
    'Return the state of a given workertype as stored by the provisioner. ',
    'This state is stored as three lists: 1 for all instances, 1 for requests',
    'which show in the ec2 api and 1 list for those only tracked internally',
    'in the provisioner.',
  ].join('\n'),
}, async function (req, res) {
  let workerType = req.params.workerType;
  try {
    let workerState = await this.WorkerState.load({workerType: workerType});
    res.reply(workerState._properties);
  } catch (err) {
    if (err.code === 'ResourceNotFound') {
      res.status(404).json({
        message: workerType + ' does not have any state information',
      }).end();
    }
  }
});

api.declare({
  method: 'get',
  route: '/ping',
  name: 'ping',
  title: 'Ping Server',
  description: [
    'Documented later...',
    '',
    '**Warning** this api end-point is **not stable**.',
  ].join('\n'),
}, function (req, res) {
  res.status(200).json({
    alive: true,
    uptime: process.uptime(),
  });
});

api.declare({
  method: 'get',
  route: '/api-reference',
  name: 'apiReference',
  title: 'api reference',
  description: [
    'Get an API reference!',
    '',
    '**Warning** this api end-point is **not stable**.',
  ].join('\n'),
}, function (req, res) {
  let host = req.get('host');
  let proto = req.connection.encrypted ? 'https' : 'http';
  res.status(200).json(api.reference({
    baseUrl: proto + '://' + host + '/v1',
  }));
});