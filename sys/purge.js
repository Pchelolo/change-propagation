"use strict";

var Purger    = require('htcp-purge');
var HTTPError = require('hyperswitch').HTTPError;
var uuid = require('cassandra-uuid').TimeUuid;

class PurgeService {
    constructor(options) {
        this.options = options || {};
        if (!this.options.host || !this.options.port) {
            throw new Error('Purging module must be configured with host and port');
        }
        this.purger = new Purger({
            log: this.options.log,
            routes: [ this.options ]
        });
    }

    purge(hyper, req) {
        if (!Array.isArray(req.body)) {
            throw new HTTPError({
                status: 400,
                body: {
                    type: 'bad_request',
                    description: 'Invalid request for purge service.'
                }
            });
        }

        return this.purger.purge(req.body.map((event) => {
            if (!event.meta || !event.meta.uri || !/^\/\//.test(event.meta.uri)) {
                hyper.log('error/events/purge', {
                    message: 'Invalid event URI',
                    event: event
                });
            } else {
                return 'http:' + event.meta.uri;
            }
        }).filter((event) => !!event))
        .thenReturn({ status: 201 });
    }
}

module.exports = function(options) {
    var ps = new PurgeService(options);

    return {
        spec: {
            paths: {
                '/': {
                    post: {
                        operationId: 'purge'
                    }
                }
            }
        },
        operations: {
            purge: ps.purge.bind(ps)
        }
    };
};