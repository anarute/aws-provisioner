var _ = require('lodash');

var baseAmiSet = {
  id: 'amiset1111',
  amis:
  [
    {
      region: 'us-west-1',
      hvm: 'ami-111',
      pv: 'ami-222',
    },
    {
      region: 'us-east-2',
      hvm: 'ami-111',
      pv: 'ami-222',
    },
  ],
  lastModified: '2016-05-06T21:36:32.760Z',
};

function makeAmiSet(overwrites) {
  return _.defaults(overwrites || {}, baseAmiSet);
}

module.exports = {
  baseAmiSet: baseAmiSet,
  makeAmiSet: makeAmiSet,
};
