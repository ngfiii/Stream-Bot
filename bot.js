require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  ActivityType,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
  getVoiceConnection,
} = require('@discordjs/voice');
const { Streamer, Utils, VideoStream, AudioStream } = require('@dank074/discord-video-stream');
const ytdlp = require('yt-dlp-exec');
const ffmpeg = require('ffmpeg-static');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');

// ─── Client Setup ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const streamer = new Streamer(client);

// Active stream state per guild
const activeStreams = new Map(); // guildId → { ffmpegProcess, connection }

// ─── Helper: Resolve YouTube URL to direct stream URL ────────────────────────
async function getYtStream(url) {
  const info = await ytdlp(url, {
    dumpSingleJson: true,
    noWarnings: true,
    preferFreeFormats: true,
    addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0'],
  });

  // Pick best format: video+audio combined, or best video + best audio
  let videoUrl, audioUrl;

  // Try to get a combined stream first (lower quality but simpler)
  const combined = info.formats?.find(
    (f) =>
      f.vcodec !== 'none' &&
      f.acodec !== 'none' &&
      (f.ext === 'mp4' || f.ext === 'webm')
  );

  if (combined) {
    videoUrl = combined.url;
    audioUrl = combined.url;
  } else {
    // Separate video and audio streams
    const bestVideo = info.formats
      ?.filter((f) => f.vcodec !== 'none' && f.acodec === 'none')
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

    const bestAudio = info.formats
      ?.filter((f) => f.acodec !== 'none' && f.vcodec === 'none')
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

    videoUrl = bestVideo?.url;
    audioUrl = bestAudio?.url;
  }

  return {
    videoUrl,
    audioUrl,
    title: info.title,
    duration: info.duration,
    isLive: info.is_live,
    thumbnail: info.thumbnail,
  };
}

// ─── Helper: Stop active stream ──────────────────────────────────────────────
function stopStream(guildId) {
  const state = activeStreams.get(guildId);
  if (state) {
    state.ffmpegProcess?.kill('SIGKILL');
    try {
      streamer.stopStream(guildId);
    } catch (_) {}
    try {
      const conn = getVoiceConnection(guildId);
      conn?.destroy();
    } catch (_) {}
    activeStreams.delete(guildId);
    return true;
  }
  return false;
}

// ─── Helper: Stream video+audio via FFmpeg → discord-video-stream ────────────
async function streamToDiscord(guildId, channelId, videoUrl, audioUrl) {
  // Join voice and start Go Live stream
  await streamer.joinVoice(guildId, channelId);
  const udpConn = await streamer.createStream(guildId);

  // Build FFmpeg args
  // Input: video stream (and optionally separate audio)
  const args = [
    '-re', // Real-time playback speed
    '-loglevel', 'error',
  ];

  const hasSeparateAudio = audioUrl && audioUrl !== videoUrl;

  if (hasSeparateAudio) {
    args.push('-i', videoUrl, '-i', audioUrl);
  } else {
    args.push('-i', videoUrl);
  }

  args.push(
    // Video output: H.264 720p
    '-map', '0:v:0',
    '-vf', 'scale=1280:720,fps=30',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', '2500k',
    '-pix_fmt', 'yuv420p',
    '-f', 'rawvideo',
    'pipe:1',
  );

  const ffmpegProcess = spawn(ffmpeg, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  ffmpegProcess.stderr.on('data', (d) => {
    const msg = d.toString();
    if (!msg.includes('Last message repeated')) {
      process.stderr.write(`[FFmpeg] ${msg}`);
    }
  });

  // Stream raw video frames to Discord
  udpConn.mediaConnection.setSpeaking(true);
  udpConn.mediaConnection.setVideoStatus(true);

  const videoStream = new VideoStream(udpConn, 30, 1000 / 30);
  ffmpegProcess.stdout.pipe(videoStream);

  // Audio via separate FFmpeg process
  let audioProcess;
  const audioArgs = [
    '-re',
    '-loglevel', 'error',
    '-i', hasSeparateAudio ? audioUrl : videoUrl,
    '-map', hasSeparateAudio ? '0:a:0' : '0:a:0',
    '-c:a', 'pcm_s16le',
    '-ar', '48000',
    '-ac', '2',
    '-f', 's16le',
    'pipe:1',
  ];

  audioProcess = spawn(ffmpeg, audioArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const audioStream = new AudioStream(udpConn);
  audioProcess.stdout.pipe(audioStream);

  ffmpegProcess.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.log(`[FFmpeg Video] exited with code ${code}`);
    }
    audioProcess.kill('SIGKILL');
    stopStream(guildId);
  });

  return { ffmpegProcess, audioProcess };
}

// ─── Slash Command Handler ────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, member } = interaction;

  if (commandName === 'play') {
    const url = interaction.options.getString('url');
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
      return interaction.reply({
        content: '❌ You need to be in a voice channel first!',
        ephemeral: true,
      });
    }

    if (voiceChannel.type !== ChannelType.GuildVoice) {
      return interaction.reply({
        content: '❌ You need to be in a regular voice channel (not a stage).',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    // Stop any existing stream
    stopStream(guildId);

    try {
      await interaction.editReply('🔍 Fetching video info...');
      const streamData = await getYtStream(url);

      if (!streamData.videoUrl) {
        return interaction.editReply('❌ Could not extract a video stream from that URL.');
      }

      await interaction.editReply(
        `▶️ Starting stream: **${streamData.title}**\n` +
        `${streamData.isLive ? '🔴 Live Stream' : `⏱️ Duration: ${formatDuration(streamData.duration)}`}\n` +
        `📡 Joining <#${voiceChannel.id}>...`
      );

      const { ffmpegProcess, audioProcess } = await streamToDiscord(
        guildId,
        voiceChannel.id,
        streamData.videoUrl,
        streamData.audioUrl
      );

      activeStreams.set(guildId, { ffmpegProcess, audioProcess, title: streamData.title });

      await interaction.editReply(
        `✅ Now streaming: **${streamData.title}**\n` +
        `${streamData.isLive ? '🔴 Live' : `⏱️ ${formatDuration(streamData.duration)}`}\n` +
        `Use \`/stop\` to end the stream.`
      );
    } catch (err) {
      console.error('[Play Error]', err);
      stopStream(guildId);
      await interaction.editReply(`❌ Failed to stream: \`${err.message}\``);
    }
  }

  if (commandName === 'stop') {
    const stopped = stopStream(guildId);
    if (stopped) {
      await interaction.reply('⏹️ Stream stopped and bot disconnected.');
    } else {
      await interaction.reply({ content: '❌ No active stream found.', ephemeral: true });
    }
  }

  if (commandName === 'nowplaying') {
    const state = activeStreams.get(guildId);
    if (state) {
      await interaction.reply(`🎬 Currently streaming: **${state.title}**`);
    } else {
      await interaction.reply({ content: '❌ Nothing is streaming right now.', ephemeral: true });
    }
  }
});

// ─── Helper: Format seconds → HH:MM:SS ───────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s]
    .map((v, i) => (i === 0 && v === 0 ? null : String(v).padStart(2, '0')))
    .filter(Boolean)
    .join(':');
}

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity('YouTube streams 📺', { type: ActivityType.Watching });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  for (const [guildId] of activeStreams) stopStream(guildId);
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
