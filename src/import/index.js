'use strict';

module.exports = (router) => {
  return {
    importResources: require('./ImportResource')(router),
  };
};
