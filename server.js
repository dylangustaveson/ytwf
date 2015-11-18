var app = require('express')();
var server = require('http').Server(app);
var io = require('socket.io')(server);
var redis = require('redis').createClient();
var request = require('request');
var moment = require('moment');

io.on("error", function (err) {
    console.log("Socket.io error: " + err);
});

app.get('/', function(req, res){
  res.sendFile('index.html', { root: './' });
});

app.get('/static/:file', function(req, res) {
	res.sendFile(req.params.file, { root: './static' });
});

var songs = {}, noSongs = false, currentSong, currentSongTime, currentSongEndTime, syncInterval, nextSongTimeout, listeners = 0;
var songQueue = [];

function setNextSong(cb) {	
	currentSong = songQueue[0];

	if (currentSong == null) {
		noSongs = true;
	} else {
		noSongs = false;

		songQueue.push(songQueue.splice(0, 1)[0]);
	}

	if (cb) { cb(); }
};

function nextSong() {
	clearTimeout(nextSongTimeout);

	setNextSong(function() {
		if (noSongs) {
			return;
		}

		currentSongTime = currentSong.time;
		currentSongEndTime = new Date(new Date() + (currentSongTime * 1000));
		emitSync();
		emitSongEnded(currentSong);

		nextSongTimeout = setTimeout(function() {
			nextSong();
		}, currentSongTime * 1000);
	});		
};

function getSyncObj() {	
	var timeDiff = new Date() - currentSongEndTime;
	return {
		currentSong: currentSong,
		syncTime: timeDiff / 1000,
		listeners: listeners
	};
}

function emitSync() {
	if (noSongs) {
		return;
	}

	var syncObj = getSyncObj();

	io.emit('sync:song', syncObj);

	syncInterval = syncInterval || setInterval(function() {
		emitSync();
	}, 1000);
};

function deleteSong(id) {
	var songId = id || currentSong || currentSong.id;

	redis.hdel('songs', songId);
	listSyncDeletePatch(songs[songId]);
	delete songs[songId];

	for (var i in songQueue) {
		if (songQueue[i].id == id) {
			songQueue.splice(i, 1);
		}
	}

	if (currentSong && songId == currentSong.id) {
		nextSong();
	}
};

function emitSongEnded(songObj) {
	io.emit("listSync:songEnded", songObj.id);
};

function getSongObj (ytReply) {
	ytReply = JSON.parse(ytReply);

	var songObj = ytReply.items[0];

	if (songObj) {
		return {
			id: songObj.id,
			title: songObj.snippet.title,
			time: parseTime(songObj.contentDetails.duration),
			valid: songObj.status.embeddable
		};
	} else {
		return null;
	}
}

function parseTime(duration) {
    var a = duration.match(/\d+/g);

    if (duration.indexOf('M') >= 0 && duration.indexOf('H') == -1 && duration.indexOf('S') == -1) {
        a = [0, a[0], 0];
    }

    if (duration.indexOf('H') >= 0 && duration.indexOf('M') == -1) {
        a = [a[0], 0, a[1]];
    }
    if (duration.indexOf('H') >= 0 && duration.indexOf('M') == -1 && duration.indexOf('S') == -1) {
        a = [a[0], 0, 0];
    }

    duration = 0;

    if (a.length == 3) {
        duration = duration + parseInt(a[0]) * 3600;
        duration = duration + parseInt(a[1]) * 60;
        duration = duration + parseInt(a[2]);
    }

    if (a.length == 2) {
        duration = duration + parseInt(a[0]) * 60;
        duration = duration + parseInt(a[1]);
    }

    if (a.length == 1) {
        duration = duration + parseInt(a[0]);
    }
    return duration
}

//http://stackoverflow.com/questions/3452546/javascript-regex-how-to-get-youtube-video-id-from-url
function getVideoId (txt) {
	var regExp = /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/)|(?:(?:watch)?\?v(?:i)?=|\&v(?:i)?=))([^#\&\?]*).*/;
	var match = txt.match(regExp);
	if (match) {
  		return match[1];
	} else {
		//maybe it was id only?
  		return txt;
	}
}

function addSong(id) {
	if (id == null) {
		return;
	}

	var ytId = getVideoId(id);

	if (songs[ytId] == null) {

		request('https://www.googleapis.com/youtube/v3/videos?videoEmbeddable=true&id='+ytId+'&part=snippet,contentDetails,status&key=AIzaSyBA68dTYz_KFf0wg6uRgADXs93_iIJczPk',
			function(error, response, body) {
				if (!error && response.statusCode === 200) {
					var songObj = getSongObj(body);
					if (songObj && songObj.valid) {
						redis.hset('songs', ytId, JSON.stringify(songObj));
						songQueue.push(songObj);
						songs[ytId] = songObj;
						listSyncAddPatch(songObj);
						if (noSongs) {
							nextSong();
						}
					}
				}
			}
		);	
	}
};

function queueSong(id) {
	for (var i in songQueue) {
		if (songQueue[i].id == id) {
			songQueue.unshift(songQueue.splice(i, 1)[0]);
		}
	}
	
	io.emit("listSync:songQueued", id);
}

function dequeueSong(id) {
	for (var i = 0; i < songQueue.length; i++) {
		if (songQueue[i].id == id) {
			songQueue.push(songQueue.splice(i, 1)[0]);
			emitSongEnded({id: id});
		}
	}
}

function listSync(socket) {
	if (socket) {
		socket.emit('listSync', songQueue);
	} else {
		io.emit('listSync', songQueue);
	}
}

function listSyncAddPatch (songObj) {
	io.emit('listSync:add', songObj);
}

function listSyncDeletePatch (songObj) {
	io.emit('listSync:delete', songObj);
}

function shuffle(silent) {
	var temp = [];

	for (var i in songs) {
		temp.push(songs[i]);
	}

	songQueue = [];

	while(temp.length > 0) {
		var index = Math.floor(Math.random() * temp.length);
		songQueue.push(temp.splice(index, 1)[0]);
	}

	if (!silent) {
		listSync();
	}
}

io.on('connection', function(socket) {
	listeners++;

	socket.on('skip', nextSong);
	socket.on('delete', deleteSong);
	socket.on('add', addSong);
	socket.on('queue', queueSong);
	socket.on('dequeue', dequeueSong);
	socket.on('shuffle', shuffle);

	socket.emit('sync', getSyncObj());

	listSync(socket);

	socket.on('disconnect', function () {
		listeners--;
	});
});


redis.hgetall('songs', function(err, dbSongs) {
	if (err) {
		console.log(err);
		return;
	}
	for (var key in dbSongs) {
		if (dbSongs.hasOwnProperty(key)) {
			var song = JSON.parse(dbSongs[key]);
			songs[key] = song;
		}
	}

	shuffle();

	server.listen(80);
	console.log('server listening');
	nextSong();
	emitSync();
});
