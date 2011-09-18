/*
   to regenerate gold files:
   node test.js -g
*/

var net = require('net');
var fs = require('fs');
var dgram = require('dgram');

var _ = require('underscore');

var logger = require('bitfloor/logger');
var Messenger = require('bitfloor/messenger');

var Matcher = require('../');
var json2 = require('../deps/json2'); // for pretty-serialize

var BASE_DIR = __dirname + "/unit";
var TIMEOUT = 100;

var matcher_config = {
    no_recover: true,
    client: {
        ip: 'localhost',
        port: 10001
    },
    feed: {
        ip: '239.255.0.1',
        port: 10001
    }
};

// create the matcher used for testing
var product_id = 0; // fake id, matcher doesn't care except to save state
var matcher = new Matcher(product_id, matcher_config);

var env = require('bitfloor/config').env;

var journal_file = env.logdir + '/matcher.0.log';
var journal_file_out = env.logdir + '/matcher_out.0.log';

var gen_golds = process.argv.length > 2 && process.argv[2] == '-g';

function do_test(test_name, assert, cb) {
    // clear the journals
    fs.writeFileSync(journal_file, "");
    fs.writeFileSync(journal_file_out, "");

    // reset matcher state
    matcher.reset();

    matcher.start(function() {
        run_test(test_name, assert, cb);
    });
}

function run_test(test_name, assert, cb) {
    var test_dir = BASE_DIR + "/" + test_name;
    var journal_test_file = test_dir + "/journal.log";
    var recv_filename = test_dir + "/recv.json";
    var recvm_filename = test_dir + "/recv_multi.json";
    var state_filename = test_dir + "/state.json";
    var orders = JSON.parse(fs.readFileSync(test_dir + "/send.json"));
    var start_time;
    var end_time;

    var tid; // timeout id

    var resps = [];
    var resps_multi = [];
    var states = [];

    var feed = dgram.createSocket('udp4');

    var client = net.createConnection(matcher_config.client.port);
    client.on('connect', function() {
        var ms = new Messenger(client);

        // listen for multicast messages
        feed.bind(matcher_config.feed.port, matcher_config.feed.ip);
        feed.addMembership(matcher_config.feed.ip);

        ms.addListener('msg', function(msg) {
            end_time = Date.now()/1000;
            resps.push(msg);

            clearTimeout(tid);
            tid = setTimeout(end, TIMEOUT);
        });

        feed.on('message', function(msg_buf) {
            end_time = Date.now()/1000;

            var msg = JSON.parse(msg_buf.toString('utf8'));
            resps_multi.push(msg);

            clearTimeout(tid);
            tid = setTimeout(end, TIMEOUT);
        });

        start_time = Date.now()/1000;
        orders.forEach(function(order){
            ms.send(order);
        });

        // send a state message, just to test that code
        ms.send({type: 'state'});

        logger.trace('sent all messages for: ' +  test_name)

        tid = setTimeout(end, TIMEOUT);
    });

    matcher.on('process', function() {
        states.push(matcher.state());
    });

    function process_journal(journal) {
        var a = [];
        journal.split('\n').forEach(function(line) {
            if(line.length) {
                var obj = JSON.parse(line);
                a.push(obj);
            }
        });
        remove_timestamps(a);
        remove_match_ids(a);
        return a;
    }

    // remove all match ids
    // match ids need to be removed because they are randomly generated
    // and thus will not match during testing
    function remove_match_ids(arr) {
        arr.forEach(function(m) {
            if(m.type === 'match')
                delete m.payload.id;
        });
    }

    // remove all timestamps from an array
    function remove_timestamps(arr) {
        arr.forEach(function(r) {
            delete r.timestamp;
            if(r.payload)
                delete r.payload.timestamp;
        });
    }

    function end() {
        feed.close();
        client.end();
        matcher.stop();

        remove_timestamps(resps);
        remove_timestamps(resps_multi);
        remove_match_ids(resps_multi);

        var journal = fs.readFileSync(journal_file) + "";

        if(gen_golds) {
            fs.writeFileSync(journal_test_file, journal);
            fs.writeFileSync(recv_filename, json2.stringify(resps, null, '\t'));
            fs.writeFileSync(recvm_filename, json2.stringify(resps_multi, null, '\t'));
            fs.writeFileSync(state_filename, json2.stringify(states, null, '\t'));
        }
        else {
            var grecv = JSON.parse(fs.readFileSync(recv_filename));
            var grecvm = JSON.parse(fs.readFileSync(recvm_filename));
            var gstate = JSON.parse(fs.readFileSync(state_filename));
            var gjournal = fs.readFileSync(journal_test_file) + "";
            assert.deepEqual(resps, grecv);
            assert.deepEqual(resps_multi, grecvm);
            assert.deepEqual(states, gstate);
            assert.deepEqual(process_journal(journal), process_journal(gjournal));
        }

        if(cb)
            cb({
                time: end_time - start_time
            });
    }
}

function make_test(name) {
    return function(assert) {
        do_test(name, assert, function(ret) {
            logger.trace('ran test in: ' + ret.time);
            assert.done();
        });
    }
}

// load and run tests
var tests = fs.readdirSync(BASE_DIR);

// if we ran as mainprog (not under nodeunit) then we need to run manually
// TODO this is jenky and should be changed
if (require.main === module) {
    var assert = require('assert');

    function process_tests(tests) {
        var test = tests.shift();
        if(test) {
            logger.trace('running test: ' + test);
            do_test(test, assert, function(ret) {
                console.log('ran test in', ret.time);
                process_tests(tests);
            });
        }
    }

    process_tests(tests);
} else {
    // running under nodeunit, setup tests

    logger.silence(0);
    var test_name;
    while (test_name = tests.shift()) {
        module.exports[test_name] = make_test(test_name);
    }
}

