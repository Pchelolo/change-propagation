"use strict";

const ChangeProp = require('../utils/changeProp');
const KafkaFactory = require('../../lib/kafka_factory');
const nock = require('nock');
const preq = require('preq');
const Ajv = require('ajv');
const assert = require('assert');
const yaml = require('js-yaml');
const common = require('../utils/common');
const P = require('bluebird');

describe('Basic rule management', function() {
    this.timeout(2000);

    const changeProp = new ChangeProp('config.test.yaml');
    const kafkaFactory = new KafkaFactory({
        uri: 'localhost:2181/', // TODO: find out from the config
        clientId: 'change-prop-test-suite',
        dc_name: 'test_dc'
    });
    let producer;
    let retrySchema;
    let errorSchema;

    before(function() {
        // Setting up might tike some tome, so disable the timeout
        this.timeout(20000);

        return kafkaFactory.newProducer(kafkaFactory.newClient())
        .then((newProducer) => {
            producer = newProducer;
            if (!common.topics_created) {
                common.topics_created = true;
                return P.each(common.ALL_TOPICS, (topic) => {
                    return producer.createTopicsAsync([ topic ], false);
                });
            }
            return P.resolve();
        })
        .then(() => changeProp.start())
        .then(() => preq.get({
                uri: 'https://raw.githubusercontent.com/wikimedia/mediawiki-event-schemas/master/jsonschema/change-prop/retry/1.yaml'
        }))
        .then((res) => retrySchema = yaml.safeLoad(res.body))
        .then(() => preq.get({
                uri: 'https://raw.githubusercontent.com/wikimedia/mediawiki-event-schemas/master/jsonschema/error/1.yaml'
        }))
        .then((res) => errorSchema = yaml.safeLoad(res.body));
    });

    function arrayWithLinks(link, num) {
        const result = [];
        for(let idx = 0; idx < num; idx++) {
            result.push({
                pageid: 1,
                ns: 0,
                title: link
            });
        }
        return result;
    }

    it('Should call simple executor', () => {
        const service = nock('http://mock.com', {
            reqheaders: {
                test_header_name: 'test_header_value',
                'content-type': 'application/json',
                'x-request-id': common.SAMPLE_REQUEST_ID,
                'x-triggered-by': 'simple_test_rule:/sample/uri',
                'user-agent': 'ChangePropTestSuite'
            }
        })
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test'
        }).reply({});

        return producer.sendAsync([{
            topic: 'test_dc.simple_test_rule',
            messages: [
                JSON.stringify(common.eventWithMessage('this_will_not_match')),
                JSON.stringify(common.eventWithMessage('test')),
                // The empty message should cause a failure in the match test
                '{}' ]
        }])
        .delay(common.REQUEST_CHECK_DELAY)
        .then(() => service.done())
        .finally(() => nock.cleanAll());
    });

    it('Should not follow redirects', (done) => {
        let finished = false;
        const service = nock('http://mock.com')
        .get('/will_redirect')
        .reply(301, '', {
            'location': 'http://mock.com/redirected_resource'
        })
        .get('/redirected_resource')
        .reply(() => {
            finished = true;
            done(new Error('Must not have followed the redirect'))
        });

        return producer.sendAsync([{
            topic: 'test_dc.simple_test_rule',
            messages: [
                JSON.stringify(common.eventWithMessage('redirect'))
            ]
        }])
        .delay(common.REQUEST_CHECK_DELAY)
        .finally(() => {
            nock.cleanAll();
            if (!finished) {
                done();
            }
        });
    });

    it('Should retry simple executor', () => {
        const service = nock('http://mock.com', {
            reqheaders: {
                test_header_name: 'test_header_value',
                'content-type': 'application/json',
                'x-request-id': common.SAMPLE_REQUEST_ID,
                'user-agent': 'ChangePropTestSuite'
            }
        })
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test'
        })
        .matchHeader('x-triggered-by', 'simple_test_rule:/sample/uri')
        .reply(500, {})
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test'
        })
        .matchHeader('x-triggered-by', 'simple_test_rule:/sample/uri,change-prop.retry.simple_test_rule:/sample/uri')
        .reply(200, {});

        return producer.sendAsync([{
            topic: 'test_dc.simple_test_rule',
            messages: [ JSON.stringify(common.eventWithMessage('test')) ]
        }])
        .delay(common.REQUEST_CHECK_DELAY)
        .then(() => service.done())
        .finally(() => nock.cleanAll());
    });

    it('Should emit valid retry message', (done) => {
        const service = nock('http://mock.com', {
            reqheaders: {
                test_header_name: 'test_header_value',
                'content-type': 'application/json',
                'x-request-id': common.SAMPLE_REQUEST_ID,
                'user-agent': 'ChangePropTestSuite'
            }
        })
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test'
        })
        .reply(500, {})
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test'
        })
        .reply(200, {});
        
        return kafkaFactory.newConsumer(kafkaFactory.newClient(),
            'change-prop.retry.simple_test_rule',
            'change-prop-test-consumer-valid-retry')
        .then((retryConsumer) => {
            retryConsumer.once('message', (message) => {
                try {
                    const ajv = new Ajv();
                    const validate = ajv.compile(retrySchema);
                    const msg = JSON.parse(message.value);
                    const valid = validate(msg);
                    if (!valid) {
                        done(new assert.AssertionError({
                            message: ajv.errorsText(validate.errors)
                        }));
                    } else if (msg.triggered_by !== 'simple_test_rule:/sample/uri') {
                            done(new Error('TriggeredBy should be equal to simple_test_rule:/sample/uri'));
                    } else {
                        done();
                    }
                } catch(e) {
                    done(e);
                }
            });
            return producer.sendAsync([{
                topic: 'test_dc.simple_test_rule',
                messages: [ JSON.stringify(common.eventWithMessage('test')) ]
            }]);
        });
    });

    it('Should retry simple executor no more than limit', () => {
        const service = nock('http://mock.com', {
            reqheaders: {
                test_header_name: 'test_header_value',
                'content-type': 'application/json',
                'x-request-id': common.SAMPLE_REQUEST_ID,
                'user-agent': 'ChangePropTestSuite'
            }
        })
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test'
        })
        .matchHeader('x-triggered-by', 'simple_test_rule:/sample/uri')
        .reply(500, {})
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test'
        })
        .matchHeader('x-triggered-by', 'simple_test_rule:/sample/uri,change-prop.retry.simple_test_rule:/sample/uri')
        .reply(500, {})
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test'
        })
        .matchHeader('x-triggered-by', 'simple_test_rule:/sample/uri,change-prop.retry.simple_test_rule:/sample/uri,change-prop.retry.simple_test_rule:/sample/uri')
        .reply(500, {});

        return producer.sendAsync([{
            topic: 'test_dc.simple_test_rule',
            messages: [ JSON.stringify(common.eventWithMessage('test')) ]
        }])
        .delay(common.REQUEST_CHECK_DELAY)
        .then(() => service.done())
        .finally(() => nock.cleanAll());
    });

    it('Should not retry if retry_on not matched', () => {
        const service = nock('http://mock.com', {
            reqheaders: {
                test_header_name: 'test_header_value',
                'content-type': 'application/json',
                'x-request-id': common.SAMPLE_REQUEST_ID,
                'x-triggered-by': 'simple_test_rule:/sample/uri',
                'user-agent': 'ChangePropTestSuite'
            }
        })
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test'
        })
        .reply(404, {});

        return producer.sendAsync([{
            topic: 'test_dc.simple_test_rule',
            messages: [ JSON.stringify(common.eventWithMessage('test')) ]
        }])
        .delay(common.REQUEST_CHECK_DELAY)
        .then(() => service.done())
        .finally(() => nock.cleanAll());
    });

    it('Should not crash with unparsable JSON', () => {
        const service = nock('http://mock.com', {
            reqheaders: {
                test_header_name: 'test_header_value',
                'content-type': 'application/json',
                'x-request-id': common.SAMPLE_REQUEST_ID,
                'x-triggered-by': 'simple_test_rule:/sample/uri',
                'user-agent': 'ChangePropTestSuite'
            }
        })
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test'
        })
        .reply(200, {});

        return producer.sendAsync([{
            topic: 'test_dc.simple_test_rule',
            messages: [ 'non-parsable-json', JSON.stringify(common.eventWithMessage('test')) ]
        }])
        .delay(common.REQUEST_CHECK_DELAY)
        .then(() => service.done())
        .finally(() => nock.cleanAll());
    });

    it('Should support producing to topics on exec', () => {
        const service = nock('http://mock.com', {
            reqheaders: {
                test_header_name: 'test_header_value',
                'content-type': 'application/json',
                'x-request-id': common.SAMPLE_REQUEST_ID,
                'user-agent': 'ChangePropTestSuite'
            }
        })
        .post('/', {
            'test_field_name': 'test_field_value',
            'derived_field': 'test'
        })
        .matchHeader('x-triggered-by', 'test_dc.kafka_producing_rule:/sample/uri,simple_test_rule:/sample/uri')
        .times(2).reply({});

        return producer.sendAsync([{
            topic: 'test_dc.kafka_producing_rule',
            messages: [ JSON.stringify(common.eventWithProperties('test_dc.kafka_producing_rule', {
                produce_to_topic: 'simple_test_rule'
            })) ]
        }])
        .delay(common.REQUEST_CHECK_DELAY)
        .then(() => service.done())
        .finally(() => nock.cleanAll());
    });

    it('Should process backlinks', () => {
        const mwAPI = nock('https://en.wikipedia.org')
        .post('/w/api.php', {
            format: 'json',
            action: 'query',
            list: 'backlinks',
            bltitle: 'Main_Page',
            blfilterredir: 'nonredirects',
            bllimit: '500' })
        .reply(200, {
            batchcomplete: '',
            continue: {
                blcontinue: '1|2272',
                continue: '-||'
            },
            query: {
                backlinks: arrayWithLinks('Some_Page', 2)
            }
        })
        .get('/api/rest_v1/page/html/Some_Page')
        .matchHeader('x-triggered-by', 'mediawiki.revision_create:/sample/uri,resource_change:https://en.wikipedia.org/wiki/Some_Page')
        .times(2)
        .reply(200)
        .post('/w/api.php', {
            format: 'json',
            action: 'query',
            list: 'backlinks',
            bltitle: 'Main_Page',
            blfilterredir: 'nonredirects',
            bllimit: '500',
            blcontinue: '1|2272'
        })
        .reply(200, {
            batchcomplete: '',
            query: {
                backlinks: arrayWithLinks('Some_Page', 1)
            }
        })
        .get('/api/rest_v1/page/html/Some_Page')
        .matchHeader('x-triggered-by', 'mediawiki.revision_create:/sample/uri,resource_change:https://en.wikipedia.org/wiki/Some_Page')
        .reply(200);

        return producer.sendAsync([{
            topic: 'test_dc.mediawiki.revision_create',
            messages: [
                JSON.stringify(common.eventWithProperties('mediawiki.revision_create', { title: 'Main_Page' }))
            ]
        }])
        .delay(common.REQUEST_CHECK_DELAY)
        .then(() => mwAPI.done())
        .finally(() => nock.cleanAll());
    });

    it('Should emit valid messages to error topic', (done) => {
        // No need to emit new messages, we will use on from previous test
        kafkaFactory.newConsumer(kafkaFactory.newClient(),
            'change-prop.error',
            'change-prop-test-error-consumer')
        .then((errorConsumer) => {
            errorConsumer.once('message', (message) => {
                try {
                    const ajv = new Ajv();
                    const validate = ajv.compile(errorSchema);
                    var valid = validate(JSON.parse(message.value));
                    if (!valid) {
                        done(new assert.AssertionError({
                            message: ajv.errorsText(validate.errors)
                        }));
                    } else {
                        done();
                    }
                } catch(e) {
                    done(e);
                }
            });
        })
        .then(() => {
            return producer.sendAsync([{
                topic: 'test_dc.mediawiki.revision_create',
                messages: [ 'not_a_json_message' ]
            }]);
        });
    });

    after(() => changeProp.stop());
});