var app = require("express")();
var server = require("http").Server(app);
var io = require("socket.io")(server);
var redis = require("redis").createClient();
var request = require("request");

var googleApiKey = process.env.GOOGLE_API_KEY;

io.on("error", function(err) {
  console.log("Socket.io error: " + err);
});

app.get("/", function(req, res) {
  res.sendFile("index.html", { root: "./" });
});

app.get("/static/:file", function(req, res) {
  res.sendFile(req.params.file, { root: "./static" });
});

var songs = {},
  noSongs = false,
  currentSong,
  currentSongTime,
  currentSongEndTime,
  syncInterval,
  nextSongTimeout,
  listeners = 0,
  songQueue = [];

function setNextSong(cb) {
  currentSong = songQueue[0];

  if (currentSong == null) {
    noSongs = true;
  } else {
    noSongs = false;

    songQueue.push(songQueue.splice(0, 1)[0]);
  }

  if (cb) {
    cb();
  }
}

function nextSong() {
  clearTimeout(nextSongTimeout);

  setNextSong(function() {
    if (noSongs) {
      return;
    }

    currentSongTime = currentSong.time;
    currentSongEndTime = new Date(new Date() + currentSongTime * 1000);

    emitSync();
    emitSongEnded(currentSong);

    nextSongTimeout = setTimeout(function() {
      nextSong();
    }, currentSongTime * 1000);
  });
}

function createSyncEvent() {
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

  var syncObj = createSyncEvent();

  io.emit("sync:song", syncObj);

  syncInterval =
    syncInterval ||
    setInterval(function() {
      emitSync();
    }, 1000);
}

function deleteSong(songId) {
  redis.hdel("songs", songId);
  listSyncDeletePatch(songs[songId]);
  delete songs[songId];

  for (var i in songQueue) {
    if (songQueue[i].id == songId) {
      songQueue.splice(i, 1);
    }
  }

  if (currentSong && songId == currentSong.id) {
    nextSong();
  }
}

function emitSongEnded(songObj) {
  io.emit("listSync:songEnded", songObj.id);
}

function getSongObj(youtubeResponse) {
  youtubeResponse = JSON.parse(youtubeResponse);

  var songObj = youtubeResponse.items[0];

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

  if (
    duration.indexOf("M") >= 0 &&
    duration.indexOf("H") == -1 &&
    duration.indexOf("S") == -1
  ) {
    a = [0, a[0], 0];
  }

  if (duration.indexOf("H") >= 0 && duration.indexOf("M") == -1) {
    a = [a[0], 0, a[1]];
  }
  if (
    duration.indexOf("H") >= 0 &&
    duration.indexOf("M") == -1 &&
    duration.indexOf("S") == -1
  ) {
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
  return duration;
}

//http://stackoverflow.com/questions/3452546/javascript-regex-how-to-get-youtube-video-id-from-url
function getVideoId(url) {
  var regExp = /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/)|(?:(?:watch)?\?v(?:i)?=|\&v(?:i)?=))([^#\&\?]*).*/;
  var match = url.match(regExp);
  if (match) {
    return match[1];
  } else {
    return url;
  }
}

function addSong(url) {
  if (url == null) {
    return;
  }

  var youtubeVideoId = getVideoId(url);

  if (songs[youtubeVideoId] == null) {
    request(
      `https://www.googleapis.com/youtube/v3/videos?videoEmbeddable=true&id=${youtubeVideoId}&part=snippet,contentDetails,status&key=${googleApiKey}`,
      function(error, response, body) {
        if (error) throw new Error(error);

        var songObj = getSongObj(body);

        if (songObj && songObj.valid) {
          redis.hset("songs", youtubeVideoId, JSON.stringify(songObj));
          songQueue.push(songObj);
          songs[youtubeVideoId] = songObj;
          listSyncAddPatch(songObj);
          if (noSongs) {
            nextSong();
          }
        }
      }
    );
  }
}

function queueSong(songId) {
  for (var i in songQueue) {
    if (songQueue[i].id == songId) {
      songQueue.unshift(songQueue.splice(i, 1)[0]);
    }
  }

  io.emit("listSync:songQueued", songId);
}

function dequeueSong(songId) {
  for (var i = 0; i < songQueue.length; i++) {
    if (songQueue[i].id == songId) {
      songQueue.push(songQueue.splice(i, 1)[0]);
      emitSongEnded({ id: songId });
    }
  }
}

function listSync(socket) {
  if (socket) {
    socket.emit("listSync", songQueue);
  } else {
    io.emit("listSync", songQueue);
  }
}

function listSyncAddPatch(songObj) {
  io.emit("listSync:add", songObj);
}

function listSyncDeletePatch(songObj) {
  io.emit("listSync:delete", songObj);
}

function shuffle(silent) {
  var temp = [];

  for (var i in songs) {
    temp.push(songs[i]);
  }

  songQueue = [];

  while (temp.length > 0) {
    var index = Math.floor(Math.random() * temp.length);
    songQueue.push(temp.splice(index, 1)[0]);
  }

  if (!silent) {
    listSync();
  }
}

io.on("connection", function(socket) {
  listeners++;

  socket.on("skip", nextSong);
  socket.on("delete", deleteSong);
  socket.on("add", addSong);
  socket.on("queue", queueSong);
  socket.on("dequeue", dequeueSong);
  socket.on("shuffle", shuffle);

  socket.emit("sync", createSyncEvent());

  listSync(socket);

  socket.on("disconnect", function() {
    listeners--;
  });
});

redis.hgetall("songs", function(err, dbSongs) {
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
  console.log("server listening");
  nextSong();
  emitSync();
});
