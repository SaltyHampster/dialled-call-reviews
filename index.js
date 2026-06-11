// index.js — Dialled Call Review Notifications
// Posts completed call review notes to each student's private 1-1 Discord channel
// Packages: discord.js, dotenv, express, cors, pg

require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const express = require("express");
const cors    = require("cors");
const { Pool } = require("pg");

// ── Database ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runMigrations() {
  // Maps each student to their private 1-1 channel
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_channels (
      id         SERIAL PRIMARY KEY,
      student_id TEXT        NOT NULL UNIQUE,
      name       TEXT        NOT NULL,
      channel_id TEXT        NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Log of review notifications sent
  await pool.query(`
    CREATE TABLE IF NOT EXISTS review_log (
      id           SERIAL PRIMARY KEY,
      student_id   TEXT        NOT NULL,
      student_name TEXT        NOT NULL,
      call_date    TEXT,
      sent_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("✅ DB ready");
}

runMigrations().catch((e) => console.error("DB setup error:", e));

// ── Config ───────────────────────────────────────────────
const PORTAL_API_KEY = process.env.PORTAL_API_KEY;
const BRAND_RED      = 0xE24B4A;

// ── API key middleware ────────────────────────────────────
function requireApiKey(req, res, next) {
  if (!PORTAL_API_KEY) return next();
  if (req.headers["x-api-key"] !== PORTAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorised" });
  }
  next();
}

// ── Discord embed: split long notes across fields ────────
// Discord limits: embed description 4096 chars, field value 1024 chars
function buildReviewEmbeds(studentName, callDate, notes, callLink, videoReviewLink) {
  const embeds = [];

  let headerText =
    `**Student:** ${studentName}\n` +
    `**Call submitted:** ${callDate}\n`;

  if (callLink) {
    headerText += `**Your call:** [Watch here](${callLink})\n`;
  }
  if (videoReviewLink) {
    headerText += `**Video review:** [Watch here](${videoReviewLink})\n`;
  }

  headerText += "\nFull notes below 👇";

  const header = new EmbedBuilder()
    .setTitle("📞 Your Call Review is Ready")
    .setDescription(headerText)
    .setColor(BRAND_RED)
    .setFooter({ text: "Dialled Coaching • Call Review" })
    .setTimestamp();

  embeds.push(header);

  // Split notes into chunks that fit embed descriptions (4096 limit, use 4000 for safety)
  const chunks = [];
  let remaining = notes;
  while (remaining.length > 0) {
    if (remaining.length <= 4000) {
      chunks.push(remaining);
      break;
    }
    // Split on the last newline before 4000 chars to avoid breaking mid-sentence
    let splitAt = remaining.lastIndexOf("\n", 4000);
    if (splitAt < 1000) splitAt = 4000; // fallback if no good break point
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  for (const chunk of chunks) {
    embeds.push(
      new EmbedBuilder()
        .setDescription(chunk)
        .setColor(BRAND_RED)
    );
  }

  return embeds;
}

// ── Express ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/",       (_, res) => res.send("Dialled Call Reviews is running 📞"));
app.get("/health", (_, res) => res.json({ status: "ok" }));

// POST /api/review-complete — Lovable calls this when a review is marked complete
// Body: { student_id, student_name, call_date, notes, call_link, video_review_link }
app.post("/api/review-complete", requireApiKey, async (req, res) => {
  try {
    const { student_id, student_name, call_date, notes, call_link, video_review_link } = req.body;

    if (!student_id || !student_name || !notes) {
      return res.status(400).json({ error: "student_id, student_name and notes are required" });
    }

    // Look up the student's 1-1 channel
    const mapping = await pool.query(
      "SELECT channel_id FROM student_channels WHERE student_id = $1",
      [student_id]
    );

    if (!mapping.rows.length) {
      return res.status(404).json({
        error: `No Discord channel mapped for student_id '${student_id}'. Add one via POST /api/students.`,
      });
    }

    const channelId = mapping.rows[0].channel_id;
    const channel   = await client.channels.fetch(channelId);

    const dateText = call_date || new Date().toLocaleDateString("en-AU", {
      day: "numeric", month: "long", year: "numeric",
    });

    const embeds = buildReviewEmbeds(student_name, dateText, notes, call_link || null, video_review_link || null);

    // Discord allows max 10 embeds per message — send in batches if needed
    for (let i = 0; i < embeds.length; i += 10) {
      await channel.send({ embeds: embeds.slice(i, i + 10) });
    }

    // Log it
    await pool.query(
      "INSERT INTO review_log (student_id, student_name, call_date) VALUES ($1, $2, $3)",
      [student_id, student_name, dateText]
    );

    res.json({ success: true, message: `Review posted to ${student_name}'s channel` });
  } catch (err) {
    console.error("Review post error:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ── Student ↔ channel mapping management ─────────────────

// GET /api/students — list all mappings
app.get("/api/students", requireApiKey, async (_, res) => {
  try {
    const result = await pool.query("SELECT * FROM student_channels ORDER BY name ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// POST /api/students — add or update a mapping
// Body: { student_id, name, channel_id }
app.post("/api/students", requireApiKey, async (req, res) => {
  try {
    const { student_id, name, channel_id } = req.body;
    if (!student_id || !name || !channel_id) {
      return res.status(400).json({ error: "student_id, name and channel_id are required" });
    }
    const result = await pool.query(
      `INSERT INTO student_channels (student_id, name, channel_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (student_id) DO UPDATE SET name = $2, channel_id = $3
       RETURNING *`,
      [student_id, name, channel_id]
    );
    res.status(201).json({ success: true, student: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// DELETE /api/students/:student_id — remove a mapping
app.delete("/api/students/:student_id", requireApiKey, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM student_channels WHERE student_id = $1 RETURNING *",
      [req.params.student_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Student not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// GET /api/review-log — recent notifications sent
app.get("/api/review-log", requireApiKey, async (_, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM review_log ORDER BY sent_at DESC LIMIT 50"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ API listening on port ${PORT}`));

// ── Discord client (post-only) ────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once("ready", () => console.log(`✅ Discord bot ready: ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
