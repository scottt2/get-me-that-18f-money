var express = require('express')
var app     = express();
var server  = require('http').Server(app);
var io      = require('socket.io')(server);
var sockets = [];
var request = require('request');
var fs      = require('fs');

var endpoint    = 'https://micropurchase.18f.gov/auctions/';
var refresh     = 10;
var notToExceed = 500;

var configFile = './config.json';
var config     = require(configFile);
var auctionID  = config.auctionID;
var userID     = config.userID;
var authToken  = config.authToken;

log('Hello!');

// Due to an API change, we have to keep the current bid in memory.
// On init, we shoot for the stars! We also have some code below
// to store that last value in case we need to reboot this thing.

var lastBidFile = "./lastBid.json";
var currentBid  = require(lastBidFile);
currentBid = (currentBid.bid === undefined) ? Infinity : currentBid.bid;
log('Setting currentBid to $' + currentBid);

app.use(express.static('public'));

server.listen(1337);

io.on('connection', function(socket) {
  log('A wild client appears!');
  socket.on('disconnect', function(){
    var index = sockets.indexOf(socket);
    sockets.splice(index, 1);
    log('Client has died. Sorry for your loss. ' + sockets.length + ' left.');
  });
  sockets.push(socket);
});

function timeStamp() {
  // https://gist.github.com/hurjas/2660489
  // Create a date object with the current time
    var now = new Date();

  // Create an array with the current month, day and time
    var date = [ now.getMonth() + 1, now.getDate(), now.getFullYear() ];

  // Create an array with the current hour, minute and second
    var time = [ now.getHours(), now.getMinutes(), now.getSeconds() ];

  // Determine AM or PM suffix based on the hour
    var suffix = ( time[0] < 12 ) ? "AM" : "PM";

  // Convert hour from military time
    time[0] = ( time[0] < 12 ) ? time[0] : time[0] - 12;

  // If hour is 0, set it to 12
    time[0] = time[0] || 12;

  // If seconds and minutes are less than 10, add a zero
    for ( var i = 1; i < 3; i++ ) {
      if ( time[i] < 10 ) {
        time[i] = "0" + time[i];
      }
    }

  // Return the formatted string
    return date.join("/") + " " + time.join(":") + " " + suffix;
}

function log(msg) {
  console.log(timeStamp() + " | " + msg);
}

function getAuction(callback) {
  var options = {
    url: endpoint + auctionID,
    headers: {
      'Accept':       'text/x-json',
      'Content-Type': 'application/json',
      'Api-Key':      authToken,
    }
  };

  request(options, function(error, response, body) {
    if (error) return callback(error);
    callback(null, JSON.parse(body));
  });
}

function bidAuction(bid, callback) {
  if (bid >= notToExceed) {
    log('Bidding $' + bid + '...');

    var options = {
      url: endpoint + auctionID + '/bids',
      headers: {
        'Accept':       'text/x-json',
        'Content-Type': 'application/json',
        'Api-Key':      authToken,
      },
      body: '{"bid": {"amount": ' + bid + '}}'
    };

    request.post(options, function(error, response, body) {
      if (error) log(error);
      callback(null, JSON.parse(body));
    });
  }
  else {
    var msg = 'Bid is below the minimum of $' + notToExceed + '.';
    log(msg);
    callback(true, { error: msg });
  }
}

function eachSocket(handle, payload) {
  for(i = 0; i < sockets.length; i++) {
    sockets[i].emit(handle, payload);
  }
}

function setCurrentBid(bid, callback) {
  fs.writeFile(lastBidFile, JSON.stringify({ bid: bid }), function(err) {
    if(err) { return callback(true, err); }
    return callback(null, bid);
  });
}

var counter = refresh;
setInterval( function() {
  eachSocket('tick', counter--);

  if (counter === 0) {
    counter = refresh;

    getAuction( function(err, res){
      if (err) { eachSocket('error', { payload: err }); }
      else {

        // If user is the current winning bid.
        // Due to an API change, we no longer can count on winning_bid...
        // So since we are using auth on the GET for auctions, we get to
        // see our data in the bid objects. Now we just check to see
        // if the last bid has our data in it. #WINNING

        // **NOTE:** You may need to bootstrap the current bid data if you
        // are already the winning bidder and *then* fire this up. If you
        // don't, you'll just wind up undercutting yourself for that first
        // iteration of the loop. What a sucker.

        if ((res.auction.bids[0].bidder_id !== null ||
            res.auction.bids[0].bidder_id !== undefined) &&
            res.auction.bids[0].bidder_id === userID) {

          log('Currently winning with ' + currentBid);
          eachSocket('status', {
            payload: {
              auction: res.auction,
              winning: true
            }
          });
        }

        // If userID is no longer the current winning bid, we fire off
        // a winning:false message to any clients that are connected.

        else {

          log('Uh oh. You are no longer the winner. ;(');
          eachSocket('status', {
            payload: {
              auction: res.auction,
              winning: false
            }
          });

          // Here, we bid on the auction for one dollar less than the winning
          // amount. Due to an API change, we cannot rely on the winning_bid
          // amount (BOO!), so we first check to see if it is there (YAY!)
          // and if not (DOUBLE BOO!), we go to what the last bid was on the
          // auction and decrement that amount by 1 BIGONE.

          // **NOTE**: Just like noted above, if you are currently the winner
          // and *then* go to fire this up, you will just bid against yourself
          // and bring shame upon your family. We do not have bidder information
          // other than ourselves until *after* the auction is over.

          var bid = (res.auction.winning_bid !== undefined) ?
            res.auction.winning_bid.amount - 1 :
            res.auction.bids[0].amount - 1;

          bidAuction(bid, function(err, res) {
            if (err) { eachSocket('error', { payload: err }); }
            else {
              log('Winning with $' + bid);
              currentBid = setCurrentBid(bid, function(err, res) {
                if (err) { log('Error while saving!' + res); }
                log('Setting currentBid to $' + res);
                return res;
              });
              eachSocket('status', {
                payload: {
                  auction: res.auction,
                  winning: true
                }
              });
            }
          });
        }
      }
    });
  }
}, 1000);
