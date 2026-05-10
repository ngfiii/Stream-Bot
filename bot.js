require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const { getVoiceConnection } = require('@discordjs/voice');
const { Streamer, VideoStream, AudioStream } = require('@dank074/discord-video-stream');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const streamer = new Streamer(client);
const activeStreams = new Map();

// ─── Register slash commands ──────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Stream a YouTube video, direct URL, or upload an mp4')
      .addStringOption((o) =>
        o.setName('url').setDescription('YouTube or direct video/stream URL').setRequired(false)
      )
      .addAttachmentOption((o) =>
        o.setName('file').setDescription('Upload an mp4 file to stream').setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stop the stream and disconnect'),
    new SlashCommandBuilder()
      .setName('nowplaying')
      .setDescription('Show what is currently streaming'),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('⚠️ Could not register commands:', err.message);
  }
}

// ─── Download file to temp ────────────────────────────────────────────────────
function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `stream_${Date.now()}.mp4`);
    const file = fs.createWriteStream(tmpFile);
    const proto = url.startsWith('https') ? https : http;

    const request = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlink(tmpFile, () => {});
        return downloadToTemp(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(tmpFile, () => {});
        return reject(new Error(`Failed to download file: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(tmpFile);
      });
    });

    request.on('error', (err) => {
      fs.unlink(tmpFile, () => {});
      reject(err);
    });

    setTimeout(() => {
      request.destroy();
      fs.unlink(tmpFile, () => {});
      reject(new Error('Download timed out'));
    }, 60000);
  });
}

// ─── Check if YouTube URL ─────────────────────────────────────────────────────
function isYouTubeUrl(url) {
  return /youtube\.com|youtu\.be/.test(url);
}

// ─── Get YouTube URLs via yt-dlp with cookies ─────────────────────────────────
function getYtDlpUrls(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '-f', 'bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best',
      '--get-url',
    ];

    // Use cookies from env if provided
    if (process.env.YOUTUBE_COOKIES_FILE) {
      args.push('--cookies', process.env.YOUTUBE_COOKIES_FILE);
    }

    // Use po_token if provided
    if (process.env.YT_PO_TOKEN && process.env.YT_VISITOR_DATA) {
      args.push(
        '--extractor-args',
        `youtube:po_token=web+${process.env.YT_PO_TOKEN};visitor_data=${process.env.YT_VISITOR_DATA}`
      );
    }

    args.push(url);

    const proc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error('[yt-dlp stderr]', stderr);
        return reject(new Error('YouTube blocked this server. Set YOUTUBE_COOKIES env variable.'));
      }
      const urls = stdout.trim().split('\n').filter(Boolean);
      if (urls.length === 0) return reject(new Error('No stream URLs found'));
      resolve({
        videoUrl: urls[0],
        audioUrl: urls[1] || urls[0],
      });
    });
  });
}

function getYtDlpInfo(url) {
  return new Promise((resolve, reject) => {
    const args = ['--no-playlist', '-j', '--skip-download'];

    if (process.env.YOUTUBE_COOKIES_FILE) {
      args.push('--cookies', process.env.YOUTUBE_COOKIES_FILE);
    }

    if (process.env.YT_PO_TOKEN && process.env.YT_VISITOR_DATA) {
      args.push(
        '--extractor-args',
        `youtube:po_token=web+${process.env.YT_PO_TOKEN};visitor_data=${process.env.YT_VISITOR_DATA}`
      );
    }

    args.push(url);

    const proc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || 'yt-dlp info failed'));
      try {
        const info = JSON.parse(stdout);
        resolve({
          title: info.title || 'Unknown',
          duration: info.duration || 0,
          isLive: info.is_live || false,
        });
      } catch (e) {
        reject(new Error('Failed to parse yt-dlp output'));
      }
    });
  });
}

// ─── Stop stream ──────────────────────────────────────────────────────────────
function stopStream(guildId) {
  const state = activeStreams.get(guildId);
  if (state) {
    state.ffmpegVideo?.kill('SIGKILL');
    state.ffmpegAudio?.kill('SIGKILL');
    // Clean up temp file if exists
    if (state.tmpFile) {
      fs.unlink(state.tmpFile, () => {});
    }
    try { streamer.stopStream(guildId); } catch (_) {}
    try { getVoiceConnection(guildId)?.destroy(); } catch (_) {}
    activeStreams.delete(guildId);
    return true;
  }
  return false;
}

// ─── Stream to Discord ────────────────────────────────────────────────────────
async function streamToDiscord(guildId, channelId, videoUrl, audioUrl) {
  await streamer.joinVoice(guildId, channelId);
  const udpConn = await streamer.createStream(guildId);

  udpConn.mediaConnection.setSpeaking(true);
  udpConn.mediaConnection.setVideoStatus(true);

  const ffmpegVideo = spawn(ffmpegPath, [
    '-re', '-loglevel', 'error',
    '-i', videoUrl,
    '-vf', 'scale=1280:720',
    '-r', '30',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', '2500k',
    '-maxrate', '2500k',
    '-bufsize', '5000k',
    '-pix_fmt', 'yuv420p',
    '-an', '-f', 'rawvideo', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpegVideo.stderr.on('data', (d) => process.stderr.write(`[V] ${d}`));
  ffmpegVideo.on('error', (e) => console.error('[ffmpegVideo error]', e));

  const videoStream = new VideoStream(udpConn, 30, 1000 / 30);
  ffmpegVideo.stdout.pipe(videoStream);

  const ffmpegAudio = spawn(ffmpegPath, [
    '-re', '-loglevel', 'error',
    '-i', audioUrl,
    '-c:a', 'pcm_s16le',
    '-ar', '48000', '-ac', '2',
    '-vn', '-f', 's16le', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpegAudio.stderr.on('data', (d) => process.stderr.write(`[A] ${d}`));
  ffmpegAudio.on('error', (e) => console.error('[ffmpegAudio error]', e));

  const audioStream = new AudioStream(udpConn);
  ffmpegAudio.stdout.pipe(audioStream);

  ffmpegVideo.on('close', (code) => {
    console.log(`[ffmpegVideo] closed with code ${code}`);
    stopStream(guildId);
  });

  return { ffmpegVideo, ffmpegAudio };
}

function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s]
    .map((v, i) => (i === 0 && v === 0 ? null : String(v).padStart(2, '0')))
    .filter(Boolean).join(':');
}

// ─── Commands ─────────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guildId, member } = interaction;

  if (commandName === 'play') {
    const url = interaction.options.getString('url');
    const attachment = interaction.options.getAttachment('file');
    const voiceChannel = member?.voice?.channel;

    if (!url && !attachment)
      return interaction.reply({ content: '❌ Provide a URL or upload an mp4 file.', ephemeral: true });
    if (!voiceChannel)
      return interaction.reply({ content: '❌ Join a voice channel first!', ephemeral: true });
    if (voiceChannel.type !== ChannelType.GuildVoice)
      return interaction.reply({ content: '❌ Must be in a regular voice channel.', ephemeral: true });
    if (attachment && !attachment.contentType?.startsWith('video/'))
      return interaction.reply({ content: '❌ Attachment must be a video file.', ephemeral: true });

    await interaction.deferReply();
    stopStream(guildId);

    try {
      let videoUrl, audioUrl, title, duration, isLive, tmpFile;

      if (attachment) {
        await interaction.editReply('📥 Downloading uploaded file...');
        tmpFile = await downloadToTemp(attachment.url);
        videoUrl = tmpFile;
        audioUrl = tmpFile;
        title = attachment.name?.replace(/\.[^/.]+$/, '') || 'Uploaded file';
        duration = 0;
        isLive = false;

      } else if (isYouTubeUrl(url)) {
        await interaction.editReply('🔍 Fetching YouTube stream via yt-dlp...');
        const [info, urls] = await Promise.all([
          getYtDlpInfo(url),
          getYtDlpUrls(url),
        ]);
        ({ videoUrl, audioUrl } = urls);
        ({ title, duration, isLive } = info);

      } else {
        // Direct URL — download to temp so ffmpeg doesn't choke on auth headers
        await interaction.editReply('📥 Fetching stream...');
        tmpFile = await downloadToTemp(url);
        videoUrl = tmpFile;
        audioUrl = tmpFile;
        title = url.split('/').pop()?.split('?')[0] || 'Stream';
        duration = 0;
        isLive = false;
      }

      await interaction.editReply(`▶️ Starting: **${title}**\n📡 Joining <#${voiceChannel.id}>...`);

      const { ffmpegVideo, ffmpegAudio } = await streamToDiscord(
        guildId, voiceChannel.id, videoUrl, audioUrl
      );

      activeStreams.set(guildId, { ffmpegVideo, ffmpegAudio, title, tmpFile });

      await interaction.editReply(
        `✅ Streaming: **${title}**\n` +
        `${isLive ? '🔴 Live' : duration ? `⏱️ ${formatDuration(duration)}` : '📁 File'}\n` +
        `Use \`/stop\` to end.`
      );

    } catch (err) {
      console.error('[Play Error]', err.message);
      stopStream(guildId);
      await interaction.editReply(`❌ Error: \`${err.message}\``);
    }
  }

  if (commandName === 'stop') {
    const stopped = stopStream(guildId);
    await interaction.reply(stopped ? '⏹️ Stream stopped.' : { content: '❌ Nothing is playing.', ephemeral: true });
  }

  if (commandName === 'nowplaying') {
    const state = activeStreams.get(guildId);
    await interaction.reply(
      state ? `🎬 Now streaming: **${state.title}**` : { content: '❌ Nothing is playing.', ephemeral: true }
    );
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity('YouTube 📺', { type: ActivityType.Watching });
  await registerCommands();
});

process.on('SIGINT', () => {
  for (const [id] of activeStreams) stopStream(id);
  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
