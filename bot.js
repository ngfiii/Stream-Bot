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

// ─── Check if URL is YouTube ──────────────────────────────────────────────────
function isYouTubeUrl(url) {
  return /youtube\.com|youtu\.be/.test(url);
}

// ─── Get info via yt-dlp ──────────────────────────────────────────────────────
function getYtDlpInfo(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '--no-playlist',
      '-j',
      url,
    ]);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || 'yt-dlp failed'));
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

// ─── Get direct stream URLs via yt-dlp ───────────────────────────────────────
function getYtDlpUrls(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '--no-playlist',
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
      '--get-url',
      url,
    ]);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || 'yt-dlp failed to get URL'));
      const urls = stdout.trim().split('\n').filter(Boolean);
      if (urls.length === 0) return reject(new Error('No stream URLs found'));
      resolve({
        videoUrl: urls[0],
        audioUrl: urls[1] || urls[0], // fallback to same URL if combined
      });
    });
  });
}

// ─── Stop stream ──────────────────────────────────────────────────────────────
function stopStream(guildId) {
  const state = activeStreams.get(guildId);
  if (state) {
    state.ffmpegVideo?.kill('SIGKILL');
    state.ffmpegAudio?.kill('SIGKILL');
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
    '-vf', 'scale=1280:720,fps=30',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', '2500k',
    '-pix_fmt', 'yuv420p',
    '-an', '-f', 'rawvideo', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpegVideo.stderr.on('data', (d) => process.stderr.write(`[V] ${d}`));

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

  const audioStream = new AudioStream(udpConn);
  ffmpegAudio.stdout.pipe(audioStream);

  ffmpegVideo.on('close', () => stopStream(guildId));

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

    // Validate attachment is video
    if (attachment && !attachment.contentType?.startsWith('video/'))
      return interaction.reply({ content: '❌ Attachment must be a video file.', ephemeral: true });

    await interaction.deferReply();
    stopStream(guildId);

    try {
      let videoUrl, audioUrl, title, duration, isLive;

      if (attachment) {
        // Direct Discord CDN URL — ffmpeg can read it directly
        videoUrl = attachment.url;
        audioUrl = attachment.url;
        title = attachment.name || 'Uploaded file';
        duration = 0;
        isLive = false;
      } else if (isYouTubeUrl(url)) {
        await interaction.editReply('🔍 Fetching YouTube info via yt-dlp...');
        const [info, urls] = await Promise.all([
          getYtDlpInfo(url),
          getYtDlpUrls(url),
        ]);
        ({ videoUrl, audioUrl } = urls);
        ({ title, duration, isLive } = info);
      } else {
        // Direct URL (mp4, m3u8, etc.)
        videoUrl = url;
        audioUrl = url;
        title = url.split('/').pop() || 'Stream';
        duration = 0;
        isLive = false;
      }

      await interaction.editReply(`▶️ Starting: **${title}**\n📡 Joining <#${voiceChannel.id}>...`);

      const { ffmpegVideo, ffmpegAudio } = await streamToDiscord(
        guildId, voiceChannel.id, videoUrl, audioUrl
      );

      activeStreams.set(guildId, { ffmpegVideo, ffmpegAudio, title });

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
