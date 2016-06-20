let base = require('taskcluster-base');

const KEY_CONST = 'ami-set';

 /**
 * An AMI Set is a collection of AMIs with a single name (its AMI Set ID).
 * Each AMI in the set is keyed by its virtualization type (PV or HVM) and
 * by its AWS region.
 */

let AmiSet = base.Entity.configure({
  version: 1,

  partitionKey: base.Entity.keys.ConstantKey(KEY_CONST),
  rowKey: base.Entity.keys.StringKey('id'),

  properties: {

    id: base.Entity.types.String,
    /* This is a JSON object which contains the AMIs of an AMI set keyed by
     * their virtualization type and region. It is in the shape:
     * {
     *   hvm: {
     *       region: {
     *           us-west-1: ami-1111,
     *           us-west-2: ami-2222
     *     }
     *   },
     *   pv: {
     *       region: {
     *           us-west-1: ami-3333,
     *           us-west-2: ami-4444
     *       }
     *   }
     * }
     */
    amis: base.Entity.types.JSON,
    // Store the date of last modification for this entity
    lastModified: base.Entity.types.Date,

  },
});

/**
 * Load all the knwon Amis
 */
AmiSet.listAmiSets = async function () {

  let amislist = [];

  try {
    await base.Entity.scan.call(this, {}, {
      handler: function(item) {
        amislist.push(item.amis.json());
      },
    });
  } catch (err) {
    debug('error listing Ami sets');
    debug(err);
    if (err.stack) {
      debug(err.stack);
    }
    throw err;
  }

  return amislist;
};

module.exports = AmiSet;
