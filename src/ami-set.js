let base = require('taskcluster-base');

const KEY_CONST = 'ami-set';

 /**
 * An AMI Set is a collection of AMIs with a single name (its AMI Set ID).
 * Each AMI in the set is keyed by its virtualization type (PV or HVM) and
 * by its AWS region.
 */

let amiSet = base.Entity.configure({
  version: 1,

  partitionKey: base.Entity.keys.ConstantKey(KEY_CONST),
  rowKey: base.Entity.keys.StringKey('amiSetId'),

  properties: {

    amiSetId: base.Entity.types.String,
    amis: base.Entity.types.JSON,

  },
});
