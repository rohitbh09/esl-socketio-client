"use strict";
    // net = require('net'),
    // xml2js = require('xml2js'),
var EventEmitter2 = require('eventemitter2').EventEmitter2,
    util = require('util'),
    io = require('socket.io-client'),
    HashMap = require('hashmap'),
    generateUuid = require('node-uuid'),
    esl = require('./esl');

// define hash map for callback
    var cbMap = new HashMap();

//- function(host, port, password)
//Initializes a new instance of ESLconnection, and connects to the
// host $host on the port $port, and supplies $password to freeswitch.
//
//Intended only for an event socket in "Inbound" mode. In other words,
// this is only intended for the purpose of creating a connection to
// FreeSWITCH that is not initially bound to any particular call or channel.
//
//Does not initialize channel information (since inbound connections are
// not bound to a particular channel). In plain language, this means that
// calls to getInfo() will always return NULL.
//
//- function(fd)
//Initializes a new instance of ESLconnection, using the existing file
// number contained in $fd.
//
//Intended only for Event Socket Outbound connections. It will fail on
// Inbound connections, even if passed a valid inbound socket.
//
//The standard method for using this function is to listen for an incoming
// connection on a socket, accept the incoming connection from FreeSWITCH,
// fork a new copy of your process if you want to listen for more connections,
// and then pass the file number of the socket to new($fd).
//
//NOTE: The Connection class only supports 1 connection from FSW, the second
//  ctor option will take in a net.Socket instance (gained from net.connect or
//  on a server's connection event). For multiple connections use esl.Server
var Connection = module.exports = function() {
    EventEmitter2.call(this, {
        wildcard: true,
        delimiter: '::',
        maxListeners: 25
    });


    var len = arguments.length, self = this;

    //check if they passed a ready callback
      this.once('esl::ready', ((typeof arguments[len - 1] === 'function') ? arguments[len - 1] : this._noop));

    //reasonable defaults for values
      this.authId           = this._generateUuid();
      this.execAsync        = false;
      this.execLock         = false;
      this.connecting       = true;
      this.authed           = false;
      this.channelData      = null;
      this.cmdCallbackQueue = [];
      this.apiCallbackQueue = [];
      this.executeCallbacks = {};
      this.executeHandlers  = {};
      // esl.setLogLevel(7);
      esl._debug("ESL CONN:: started");

    //events required for the module to operate properly
      this.reqEvents = [ this.authId ];
    // this.reqEvents = ['BACKGROUND_JOB', 'CHANNEL_EXECUTE_COMPLETE'];
    this.listeningEvents = [];

    //"Inbound" connection (going into FSW)
    if(len === 3 || len === 4) { //3 (host, port, password); 4 (host, port, password, callback)
        esl._debug("ESL CONN:: with 3 or 4 argument");
        //set inbound to true
        this._inbound = true;

        //save password
        this.password = arguments[2];


        esl._debug("ESL CONN:: socket connect started");
        //connect ttheo ESL Socket
        this.socket = io.connect( `ws://${arguments[0]}:${arguments[1]}`, {
                                  "reconnect": false,
                                  "transports": ["websocket"],
                                  "rejectUnauthorized":false
                                });
        esl._debug("ESL CONN:: socket connect done");
        // this.socket = net.connect({
        //     port: arguments[1],
        //     host: arguments[0]
        // }, this._onConnect.bind(this));

        this._onConnect();
        esl._debug("ESL CONN:: _connect done");
        this.socket.on('connect_error', this._onError.bind(this));
        this.socket.on('error', this._onError.bind(this));
        this.socket.on('disconnect', this._onError.bind(this));
        esl._debug("ESL CONN:: _error done");
        var self = this;
    }
    //"Outbound" connection (coming from FSW)
    else if(len >= 1) { //1 (net.Socket); 2 (net.Socket, callback)
        esl._debug("ESL CONN:: with 1 argument");
        //set inbound to false
        this._inbound = false;

        this.socket = arguments[0];
        this.connecting = false;
        this._onConnect();
        // this.send('connect');
        this.socket.on('connect_error', this._onError.bind(this));
        this.socket.on('error', this._onError.bind(this));
    }
    //Invalid arguments passed
    else { //0 args, or more than 4
        this.emit('error', new Error('Bad arguments passed to esl.Connection'));
    }


    //emit end when stream closes
    // this.socket.on('end', function() {
    // this.socket.on('connect_error', function() {
    //     esl._debug("ESL CONN:: connect_error event");
    //     // self.emit('esl::end');
    //     self.socket = null;
    // });
    this.socket.on('disconnect', function() {
        esl._debug("ESL CONN:: disconnect event");
        self.emit('esl::end');
        self.socket = null;
    });

    //handle logdata events
    this.on('esl::event::logdata', function(log) {
        esl._debug("ESL CONN:: logdata event");
        esl._doLog(log);
    });

    //handle command reply callbacks
    this.on('esl::event::command::reply', function() {
        esl._debug("ESL CONN:: command reply");
        if(self.cmdCallbackQueue.length === 0) return;

        var fn = self.cmdCallbackQueue.shift();

        if(fn && typeof fn === 'function')
            fn.apply(self, arguments);
    });

    //handle api response callbacks
    // this.on('esl::event::api::response', function() {
    //     if(self.apiCallbackQueue.length === 0) return;

    //     var fn = self.apiCallbackQueue.shift();

    //     if(fn && typeof fn === 'function')
    //         fn.apply(self, arguments);
    // });
};

util.inherits(Connection, EventEmitter2);

/*********************
 ** Lower-level ESL Specification
 ** http://wiki.freeswitch.org/wiki/Event_Socket_Library
 **********************/

//Returns the UNIX file descriptor for the connection object,
// if the connection object is connected. This is the same file
// descriptor that was passed to new($fd) when used in outbound mode.
Connection.prototype.socketDescriptor = function() {
    esl._debug("ESL CONN:: socketDescriptor");
    if(this._inbound) return null;

    return this.socket;
};

//Test if the connection object is connected. Returns `true` if connected, `false` otherwise.
Connection.prototype.connected = function() {
    esl._debug("ESL CONN:: connected");
    return (!this.connecting && !!this.socket);
};

//When FS connects to an "Event Socket Outbound" handler, it sends
// a "CHANNEL_DATA" event as the first event after the initial connection.
// getInfo() returns an ESLevent that contains this Channel Data.
//
//getInfo() returns NULL when used on an "Event Socket Inbound" connection.
Connection.prototype.getInfo = function() {
    esl._debug("ESL CONN:: getInfo");
    return this.channelData; //remains null on Inbound socket
};

//Sends a command to FreeSWITCH.
//
//Does not wait for a reply. You should immediately call recvEvent
// or recvEventTimed in a loop until you get the reply. The reply
// event will have a header named "content-type" that has a value
// of "api/response" or "command/reply".
//
//To automatically wait for the reply event, use sendRecv() instead of send().
//
//NOTE: This is a FAF method of sending a command

Connection.prototype.send = function( command, args, type, cb ) {

    esl._debug("ESL CONN:: send");
    var self      = this,
        requestId = self._generateUuid();

    if(typeof arg === 'function') {
        cb = arg;
        arg = '';
    }

    if(typeof type === 'function') {
        cb = type;
        type = null;
    }
    //write raw command to socket
    try {

      let request = {
        "author" : self.authId,
        "requestId" : requestId,
        "type" : type || "bgapi",
        "cmd" : command,
        "args" : args || []
      };
      if(cb && typeof cb === 'function')
        self._setCallBack( requestId, cb);

      self._socketSend( request,requestId);
      esl._debug("ESL CONN:: _socketSend done");
    }
    catch(e) {
        self.emit('error', e);
        esl._debug("ESL CONN:: error", e);
    }
    esl._debug("ESL CONN:: send done");
};
Connection.prototype._socketSend = function( request, requestId ) {
  var self = this;
  esl._debug("ESL CONN:: _socketSend");
  try {
    self.socket.emit('elsRequest', request, ( error, succes ) => {
      if( error ){
        if ( typeof error == "object" )
           error = error.response || "No Response";
        self._getCallBack( requestId, self._errorResponse(error));
      }
    });
  } catch(ex){
    self._getCallBack( requestId, self._errorResponse("-ERR ESL ERROR"));
  }
}



//Internally sendRecv($command) calls send($command) then recvEvent(),
// and returns an instance of ESLevent.
//
//recvEvent() is called in a loop until it receives an event with a header
// named "content-type" that has a value of "api/response" or "command/reply",
// and then returns it as an instance of ESLevent.
//
//Any events that are received by recvEvent() prior to the reply event are queued
// up, and will get returned on subsequent calls to recvEvent() in your program.
//
//NOTE: This listens for a response when calling `.send()` doing recvEvent() in a loop
//  doesn't make sense in the contet of Node.
Connection.prototype.sendRecv = function(command, args, cb) {
    esl._debug("ESL CONN:: sendRecv");
    if(typeof args === 'function') {
        cb = args;
        args = null;
    }

    //queue callback for command reply
       cb(this._errorResponse("-ERR Not supported" + command));
};

//Send an API command (http://wiki.freeswitch.org/wiki/Mod_commands#Core_Commands)
// to the FreeSWITCH server. This method blocks further execution until
// the command has been executed.
//
//api($command, $args) is identical to sendRecv("api $command $args").
Connection.prototype.api = function(command, args, cb) {

    esl._debug("ESL CONN:: api");
    if(typeof args === 'function') {
        cb = args;
        args = '';
    }
    this.send(command, args,"bgapi",cb);
    // this.send('api ' + command + args);
};

//Send a background API command to the FreeSWITCH server to be executed in
// it's own thread. This will be executed in it's own thread, and is non-blocking.
//
//bgapi($command, $args) is identical to sendRecv("bgapi $command $args")
Connection.prototype.bgapi = function(command, args, jobid, cb) {
    esl._debug("ESL CONN:: bgapi");
    if(typeof args === 'function') {
        cb = args;
        args = '';
        jobid = null;
    }

    if(typeof jobid === 'function') {
        cb = jobid;
        jobid = null;
    }
    
    this.send(command, args,"bgapi",cb);
    // args = args || ''; //incase they pass null/false

    // if(args instanceof Array)
    //     args = args.join(' ');

    // args = ' ' + args;

    // var self = this,
    //     params = {},
    //     addToFilter = function(cb) { if(cb) cb(); },
    //     removeFromFilter = addToFilter,
    //     sendApiCommand = function(cb) {
    //         if(jobid) params['Job-UUID'] = jobid;

    //         addToFilter(function() {
    //             self.sendRecv('bgapi ' + command + args, params, function(evt) {
    //                 //got the command reply, use the Job-UUID to call user callback
    //                 if(cb) {
    //                     self.once('esl::event::BACKGROUND_JOB::' + evt.getHeader('Job-UUID'), function(evt) {
    //                         removeFromFilter(function() {
    //                             cb(evt);
    //                         });
    //                     });
    //                 }
    //                 else {
    //                     removeFromFilter();
    //                 }
    //             });
    //         });
    //     };

    // if(self.usingFilters) {
    //     jobid = jobid || generateUuid.v4();

    //     addToFilter = function(cb) {
    //         self.filter('Job-UUID', jobid, cb);
    //     };
    //     removeFromFilter = function(cb) {
    //         self.filterDelete('Job-UUID', jobid, cb);
    //     };

    //     sendApiCommand(cb);
    // }
    // else {
    //     sendApiCommand(cb);
    // }
};

//NOTE: This is a wrapper around sendRecv, that uses an ESLevent for the data
Connection.prototype.sendEvent = function(event, cb) {
    this.sendRecv('sendevent ' + event.getHeader('Event-Name') + '\n' + event.serialize(), cb);
};

//Returns the next event from FreeSWITCH. If no events are waiting, this
// call will block until an event arrives.
//
//If any events were queued during a call to sendRecv(), then the first
// one will be returned, and removed from the queue. Otherwise, then next
// event will be read from the connection.
//
//NOTE: This is the same as `connection.once('esl::event::**', ...)` and in fact
//  that is all it does. It does not block as the description says, nor does
//  it queue events. Node has a better Event system than this, use it.
Connection.prototype.recvEvent = function(cb) {
    cb = cb || this._noop;

    this.once('esl::event::**', cb);
};

//Similar to recvEvent(), except that it will block for at most $milliseconds.
//
//A call to recvEventTimed(0) will return immediately. This is useful for polling for events.
//
//NOTE: This does the same as recvEvent, except will timeout if an event isn't received in
//  the specified timeframe
Connection.prototype.recvEventTimed = function(ms, cb) {
    var self = this, timeout, fn;

    fn = function(to, event) {
        clearTimeout(to);
        if(cb) cb(event);
    };

    timeout = setTimeout(function() {
        self.removeListener('esl::event::**', fn);
        if(cb) cb();
    }, ms);

    //proxy to ensure we pass this timeout to the callback
    self.once('esl::event::**', fn.bind(self, timeout));
};

//See the event socket filter command (http://wiki.freeswitch.org/wiki/Event_Socket#filter).
Connection.prototype.filter = function(header, value, cb) {
    this.usingFilters = true;
    this.sendRecv('filter ' + header + ' ' + value, cb);
};

Connection.prototype.filterDelete = function(header, value, cb) {
    if(typeof value === 'function') {
        cb = value;
        value = null;
    }

    this.sendRecv('filter delete ' + header + (!!value ? ' ' + value : ''), cb);
};

// doen by rohit
//$event_type can have the value "plain" or "xml" or "json". Any other value specified
// for $event_type gets replaced with "plain".
//
//See the event socket event command for more info (http://wiki.freeswitch.org/wiki/Event_Socket#event).
Connection.prototype.events = function(type, events, cb) {

  var self = this;
    if(['plain','xml','json'].indexOf(type) === -1)
        type = 'plain';

    if(typeof events === 'function') {
        cb = events;
        events = 'all';
    }

    events = events || 'all';

    var all =  false;
    if(events instanceof Array)
        all = (events.length === 1 && events[0].toLowerCase() === 'all');
    else
        all = (events.toLowerCase() === 'all');

    //if we specify all that includes required events
    if(all) {
        this.listeningEvents = ['all'];
    }
    //otherwise we need to concat the events to the required events
    else {
        //set listeningEvents to the new events
        this.listeningEvents = (events instanceof Array ? events : events.split(' '));

        //if the required events are not in there, add them
        for(var i = 0, len = this.reqEvents.length; i < len; ++i) {
            if(this.listeningEvents.indexOf(this.reqEvents[i]) !== -1)
                continue;

            this.listeningEvents.push(this.reqEvents[i]);
        }
    }

    if(this.listeningEvents instanceof Array){
      for ( let event of this.listeningEvents) {
        try {

          self.socket.emit("subscribe", event);
        } catch(ex){

        }
      }
    }
};

//Execute a dialplan application (http://wiki.freeswitch.org/wiki/Mod_dptools#Applications),
// and wait for a response from the server.
// On socket connections not anchored to a channel (most of the time inbound),
// all three arguments are required -- $uuid specifies the channel to execute
// the application on.
//
//Returns an ESLevent object containing the response from the server. The
// getHeader("Reply-Text") method of this ESLevent object returns the server's
// response. The server's response will contain "+OK [Success Message]" on success
// or "-ERR [Error Message]" on failure.
Connection.prototype.execute = function(app, arg, uuid, cb) {

    var self = this, opts = {}, requestId = this._generateUuid();

    if(typeof arg === 'function') {
        cb = arg;
        arg = '';
    }

    if(typeof uuid === 'function') {
        cb = uuid;
        uuid = null;
    }

    //write raw command to socket
    try {

      let request = {
        "author"    : self.authId,
        "requestId" : requestId,
        "type"      : "execute",
        "app"       : app,
        "arg"       : args || [],
        "uuid"      : uuid
      };
      if(cb && typeof cb === 'function')
        self._setCallBack( requestId, cb);

      self._socketSend( request,requestId);
    }
    catch(e) {
        self.emit('error', e);
    }

    // //setup options
    // opts['execute-app-name'] = app;
    // opts['execute-app-arg'] = arg;

    // if(self.async) {
    //     self.once('');
    // }

    // //if inbound
    // if(self._inbound) {
    //     //if no uuid passed, create one
    //     uuid = uuid || generateUuid.v4();

    //     //execute with the new uuid
    //     self._doExec(uuid, 'execute', opts, cb);
    // }
    // //if outbound
    // else {
    //     //grab our unique-id from channel_data
    //     uuid = self.getInfo().getHeader('Unique-ID');
    //     self._doExec(uuid, 'execute', opts, cb);
    // }
};
//Same as execute, but doesn't wait for a response from the server.
//
//This works by causing the underlying call to execute() to append
// "async: true" header in the message sent to the channel.
Connection.prototype.executeAsync = function(app, arg, uuid, cb) {
    //temporarily set async to true
    var old = this.async;
    this.async = true;

    //run execute
    this.execute(app, arg, uuid, cb);

    //reset async
    this.async = old;
};

//Force async mode on for a socket connection. This command has
// no effect on outbound socket connections that are set to "async"
// in the dialplan and inbound socket connections, since these
// connections are already set to async mode on.
//
//$value should be `true` to force async mode, and `false` to not force it.
//
//Specifically, calling setAsyncExecute(true) operates by causing future calls
// to execute() to include the "async: true" header in the message sent to
// the channel. Other event socket library routines are not affected by this call.
//
//NOTE: All these bitches be async, da fuq
Connection.prototype.setAsyncExecute = function(value) {
    this.execAsync = value;
};

//Force sync mode on for a socket connection. This command has no effect on
// outbound socket connections that are not set to "async" in the dialplan,
// since these connections are already set to sync mode.
//
//$value should be `true` to force sync mode, and `false` to not force it.
//
//Specifically, calling setEventLock(1) operates by causing future calls to
// execute() to include the "event-lock: true" header in the message sent
// to the channel. Other event socket library routines are not affected by this call.
//
//See Also:
// Q: Ordering and async keyword
//      (http://wiki.freeswitch.org/wiki/Event_socket_outbound#Q:_Ordering_and_async_keyword)
// Q: Can I bridge a call with an Outbound Socket?
//      (http://wiki.freeswitch.org/wiki/Event_socket_outbound#Q:_Can_I_bridge_a_call_with_an_Outbound_socket_.3F)
Connection.prototype.setEventLock = function(value) {
    this.execLock = value;
};

//Close the socket connection to the FreeSWITCH server.
Connection.prototype.disconnect = function() {
  esl._debug("ESL CONN:: disconnect started");
  var self = this;
  try{

    self.socket.disconnect();
    self.socket = null;
  } catch( ex ){
    esl._debug("ESL CONN:: socket error");
  }
};

/*********************
 ** Higher-level Library-Specific Functions
 ** Some of these simply provide syntatic sugar
 **********************/
Connection.prototype.auth = function(cb) {

    esl._debug("ESL CONN:: esl auth started");
    this.authed = true;
    this.subscribe(this.reqEvents);
    this.emit('esl::ready');
};

//subscribe to events using json format (native support)
Connection.prototype.subscribe = function(events, cb) {

    esl._debug("ESL CONN:: subscribe started");
    events = events || 'all';

    this.events('json', events, cb);
};

//wraps the show mod_commands function and parses the return
//value into a javascript array
// Connection.prototype.show = function(item, format, cb) {
//     if(typeof format === 'function') {
//         cb = format;
//         format = null;
//     }

//     format = format || 'json';

//     this.bgapi('show ' + item + ' as ' + format, function(e) {
//         var data = e.getBody(), parsed = {};

//         //if error send them that
//         if(data.indexOf('-ERR') !== -1) {
//             if(cb) cb(new Error(data));
//             return;
//         }

//         //otherwise parse the event
//         switch(format) {
//         case 'json': //json format, easy and efficient
//             try { parsed = JSON.parse(data); }
//             catch(e) { if(cb) cb(e); return; }

//             if(!parsed.rows) parsed.rows = [];

//             break;

//         case 'xml': //xml format, need to massage a bit after parsing
//             var parser = new xml2js.Parser({ explicitArray: false, explicitRoot: false, emptyTag: '' });

//             parser.parseString(data, function(err, doc) {
//                 if(err) { if(cb) cb(err); return; }
//                 parsed.rowCount = parseInt(doc.$.rowCount, 10);
//                 parsed.rows = [];

//                 //case where only one row, means "row" is not an array
//                 if(parsed.rowCount === 1) {
//                     delete doc.row.$;
//                     parsed.rows.push(doc.row);
//                 } else {
//                     doc.row.forEach(function(row) {
//                         delete row.$;
//                         parsed.rows.push(row);
//                     });
//                 }
//             });
//             break;

//         default: //delim seperated values, custom parsing
//             if(format.indexOf('delim')) {
//                 var delim = format.replace('delim ', ''),
//                 lines = data.split('\n'),
//                 cols = lines[0].split(delim);

//                 parsed = { rowCount: lines.length - 1, rows: [] };

//                 for(var i = 1, len = lines.length; i < len; ++i) {
//                     var vals = lines[i].split(delim),
//                     o = {};
//                     for(var x = 0, xlen = vals.length; x < xlen; ++x) {
//                         o[cols[x]] = vals[x];
//                     }

//                     parsed.rows.push(o);
//                 }
//             }
//             break;
//         }

//         //return the parsed version of the data
//         if(cb) cb(null, parsed, data);
//         return;
//     });
// };

//make an originating call
// Connection.prototype.originate = function(options, cb) {
//     if(typeof options === 'function') {
//         cb = options;
//         options = null;
//     }

//     options.profile = options.profile || '';
//     options.gateway = options.gateway || '';
//     options.number  = options.number || '';
//     options.app     = options.app || '';
//     options.sync    = options.sync || false;

//     var arg = 'sofia/' + options.profile +
//                 '/' + options.number +
//                 '@' + options.gateway +
//                 (options.app ? ' &' + options.app : '');

//     if(options.sync) {
//         this.api('originate', arg, cb);
//     } else {
//         this.bgapi('originate', arg, cb);
//     }
// };

//send a SIP MESSAGE
// Connection.prototype.message = function(options, cb) {
//     if(typeof options === 'function') {
//         cb = options;
//         options = null;
//     }

//     options = options || {};

//     options.to      = options.to || '';
//     options.from    = options.from || '';
//     options.profile = options.profile || '';
//     options.body    = options.body || '';
//     options.subject = options.subject || '';
//     options.deliveryConfirmation = options.deliveryConfirmation || '';

//     var event = new Event('custom', 'SMS::SEND_MESSAGE');

//     event.addHeader('proto', 'sip');
//     event.addHeader('dest_proto', 'sip');

//     event.addHeader('from', 'sip:' + options.from);
//     event.addHeader('from_full', 'sip:' + options.from);

//     event.addHeader('to', options.to);
//     event.addHeader('sip_profile', options.profile);
//     event.addHeader('subject', options.subject);

//     if(options.deliveryConfirmation) {
//         event.addHeader('blocking', 'true');
//     }

//     event.addHeader('type', 'text/plain');
//     event.addHeader('Content-Type', 'text/plain');

//     event.addBody(options.body);

//     this.sendEvent(event, cb);
// };


/*********************
 ** Private helpers
 **********************/
//noop because EventEmitter2 makes me pass a function
Connection.prototype._noop = function() {};

//helper for execute, sends the actual message
// Connection.prototype._doExec = function(uuid, cmd, args, cb) {
//     args['call-command'] = cmd;

//     if(this.execAsync) args.async = true;
//     if(this.execLock) args['event-lock'] = true;

//     //this method of event tracking is based on:
//     //http://lists.freeswitch.org/pipermail/freeswitch-users/2013-May/095329.html
//     args['Event-UUID'] = generateUuid.v4();
//     this.executeCallbacks[args['Event-UUID']] = cb;

//     if(!this.executeHandlers[uuid]) {
//         var self = this;
//         this.on('esl::event::CHANNEL_EXECUTE_COMPLETE::' + uuid, this.executeHandlers[uuid] = function(evt) {
//             var evtUuid = evt.getHeader('Application-UUID') || evt.getHeader('Event-UUID');

//             if(self.executeCallbacks[evtUuid]) {
//                 self.executeCallbacks[evtUuid].call(self, evt);
//             }
//         });
//     }

//     this.send('sendmsg ' + uuid, args);
// };

// updated by rohit
//called on socket/generic error, simply echo the error
//to the user
Connection.prototype._onError = function(err) {
    esl._debug("ESL CONN:: _onError", err);
    this.emit('error', err);
  var self = this;
  try{

    self.socket.disconnect();
    self.socket = null;
  } catch( ex ){
    esl._debug("ESL CONN:: socket error");
  }
};

// updated by rohit
// get uuid
Connection.prototype._generateUuid = function() {
    return generateUuid.v4();
};

// updated by rohit
//called when socket connects to FSW ESL Server
//or when we successfully listen to the fd
Connection.prototype._onConnect = function() {

    esl._debug("ESL CONN:: _connect started");
    //on generic event
    this.emit('esl::connect');
    esl._debug("ESL CONN:: esl connect event brodcast");
    this.socket.on('connect', this.auth.bind(this));
    esl._debug("ESL CONN:: esl auth bind done");
    this.socket.on('ESLrespose', this._onEslReponse.bind(this));
    esl._debug("ESL CONN:: esl _onEslReponse bind done");
    this.socket.on('ESLevent', this._onEvent.bind(this));
    esl._debug("ESL CONN:: esl _onEvent bind done");
    this.connecting = false;
};

//When we get a generic ESLevent from FSW
Connection.prototype._onEslReponse = function( event ) {
  esl._debug('_onEslReponse', event)
  var body    = event.response || this._errorResponse("-ERR NO RESPONSE");
  this._getCallBack( event.requestId, body )
}

Connection.prototype._onEvent = function( event ) {
  var headers = this._parseHeader(event),
      body    = event.body || "";
  this._onEventHandler( event, headers, body )
}
Connection.prototype._onEventHandler = function(event, headers, body) {
    var emit = 'esl::event',
        uuid = headers['Job-UUID'] || headers['Unique-ID'] || headers['Core-UUID'];

    //massage Content-Types into event names,
    //since not all events actually have an Event-Name
    //header; we have to make our own
    var contentType = headers['Content-Type'] || "text/event-json";
    switch( contentType ) {
    case 'auth/request':
        emit += '::auth::request';
        break;

    case 'command/reply':
        emit += '::command::reply';

        if(headers['Event-Name'] === 'CHANNEL_DATA') {
            if(!this._inbound) {
                this.channelData = event;
                this.emit('esl::event::CHANNEL_DATA' + (!!uuid ? '::' + uuid : ''), event);
            }
        }
        break;

    case 'log/data':
        emit += '::logdata';
        break;

    case 'text/disconnect-notice':
        emit += '::disconnect::notice';
        break;

    case 'api/response':
        emit += '::api::response';
        break;


    case 'text/event-json':
    case 'text/event-plain':
    case 'text/event-xml':
        emit += '::' + headers['Event-Name'] + (!!uuid ? '::' + uuid : '');
        break;

    default:
        emit += '::raw::' + headers['Content-Type'];
    }

    this.emit(emit, event, headers, body);
};


// set call back function
Connection.prototype._setCallBack = function( uuid, callback) {
  cbMap.set( uuid, callback);
}
Connection.prototype._getCallBack = function( uuid, response ) {
  var fn = cbMap.get( uuid );
  if(fn && typeof fn === 'function')
    fn(response);
  cbMap.delete(uuid);
}

Connection.prototype._parseHeader = function( event ) {
  var headers  = {};
  if( event && event.headers ) {
    for ( let eslVal of event.headers) {
      headers[ eslVal.name ] = eslVal.value;
    }
  }
  return headers;
}

Connection.prototype._errorResponse = function( body, headers ) {

  var response = {
    "headers" : headers || [],
    "type" : "",
    "subclass" : "",
    "body" : body || "-ERR No response",
  }
  return response;
}
Connection.prototype._parseBody = function( event ) {
  // var headers  = {};
  // if( event && event.headers ) {
  //   for ( let eslVal of event.headers) {
  //     headers[ eslVal.name ] = eslVal.value;
  //   }
  // }
  // return headers;
}
// get and exicute callback