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
const ytdl = require('@distube/ytdl-core');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');

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

// ─── Register slash commands on startup ───────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Stream a YouTube video or live stream in your voice channel')
      .addStringOption((o) =>
        o.setName('url').setDescription('YouTube URL').setRequired(true)
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

// ─── Get YouTube info ─────────────────────────────────────────────────────────
async function getYtInfo(url) {
  const agent = ytdl.createAgent();
  const info = await ytdl.getInfo(url, { agent });

  let videoUrl, audioUrl;

  try {
    const videoFormat = ytdl.chooseFormat(info.formats, {
      quality: 'highestvideo',
      filter: (f) => f.container === 'mp4' && f.hasVideo && !f.hasAudio,
    });
    videoUrl = videoFormat?.url;
  } catch (_) {}

  try {
    const audioFormat = ytdl.chooseFormat(info.formats, {
      quality: 'highestaudio',
      filter: 'audioonly',
    });
    audioUrl = audioFormat?.url;
  } catch (_) {}

  // Fallback to combined format
  if (!videoUrl || !audioUrl) {
    const combined = ytdl.chooseFormat(info.formats, {
      quality: 'highest',
      filter: 'audioandvideo',
    });
    videoUrl = videoUrl || combined?.url;
    audioUrl = audioUrl || combined?.url;
  }

  return {
    videoUrl,
    audioUrl,
    title: info.videoDetails.title,
    duration: parseInt(info.videoDetails.lengthSeconds),
    isLive: info.videoDetails.isLiveContent,
  };
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
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel)
      return interaction.reply({ content: '❌ Join a voice channel first!', ephemeral: true });
    if (voiceChannel.type !== ChannelType.GuildVoice)
      return interaction.reply({ content: '❌ Must be in a regular voice channel.', ephemeral: true });

    await interaction.deferReply();
    stopStream(guildId);

    try {
      await interaction.editReply('🔍 Fetching video info...');

      const info = await Promise.race([
        getYtInfo(url),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timed out — YouTube may be blocking this server. Try again.')), 20000)
        ),
      ]);

      if (!info.videoUrl)
        return interaction.editReply('❌ Could not extract a video stream from that URL.');

      await interaction.editReply(`▶️ Starting: **${info.title}**\n📡 Joining <#${voiceChannel.id}>...`);

      const { ffmpegVideo, ffmpegAudio } = await streamToDiscord(
        guildId, voiceChannel.id, info.videoUrl, info.audioUrl
      );

      activeStreams.set(guildId, { ffmpegVideo, ffmpegAudio, title: info.title });

      await interaction.editReply(
        `✅ Streaming: **${info.title}**\n` +
        `${info.isLive ? '🔴 Live' : `⏱️ ${formatDuration(info.duration)}`}\n` +
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
client.once('ready', async () => {
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
