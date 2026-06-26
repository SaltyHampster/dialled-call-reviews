// index.js — Dialled Call Reviews + Daily Accountability
// Posts call submission alerts, completed review notes, and accountability
// updates/reminders to each student's private 1-1 Discord channel.
// Packages: discord.js, dotenv, express, cors, pg, node-cron

require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const express = require("express");
const cors    = require("cors");
const cron    = require("node-cron");
const { Pool } = require("pg");

// ── Database ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_channels (
      id         SERIAL PRIMARY KEY,
      student_id TEXT        NOT NULL UNIQUE,
      name       TEXT        NOT NULL,
      channel_id TEXT        NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS review_log (
      id           SERIAL PRIMARY KEY,
      student_id   TEXT        NOT NULL,
      student_name TEXT        NOT NULL,
      call_date    TEXT,
      event        TEXT        DEFAULT 'review',
      sent_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE review_log ADD COLUMN IF NOT EXISTS event TEXT DEFAULT 'review'`).catch(() => {});

  // Tracks which students have accountability switched on
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accountability_enabled (
      student_id TEXT        PRIMARY KEY,
      name       TEXT        NOT NULL,
      enabled    BOOLEAN     DEFAULT TRUE,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // One row per student per day — their submission for that date
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accountability_log (
      id            SERIAL PRIMARY KEY,
      student_id    TEXT        NOT NULL,
      student_name  TEXT        NOT NULL,
      log_date      DATE        NOT NULL,
      job_apps      INT         DEFAULT 0,
      call_min      INT         DEFAULT 0,
      roleplay_min  INT         DEFAULT 0,
      note          TEXT,
      streak        INT         DEFAULT 0,
      all_complete  BOOLEAN     DEFAULT FALSE,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (student_id, log_date)
    )
  `);
  await pool.query(`ALTER TABLE accountability_log ADD COLUMN IF NOT EXISTS streak INT DEFAULT 0`).catch(() => {});
  console.log("✅ DB ready");
}

runMigrations().catch((e) => console.error("DB setup error:", e));

// ── Config ───────────────────────────────────────────────
const PORTAL_API_KEY = process.env.PORTAL_API_KEY;
const BRAND_RED      = 0xE24B4A;
const PORTAL_URL     = process.env.PORTAL_URL || "https://dialled.online";

// Daily targets (used for reminder completeness check + display)
const TARGETS = { job_apps: 5, call_min: 60, roleplay_min: 60 };

// ── API key middleware ────────────────────────────────────
function requireApiKey(req, res, next) {
  if (!PORTAL_API_KEY) return next();
  if (req.headers["x-api-key"] !== PORTAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorised" });
  }
  next();
}

// ── Helper: fetch a student's channel or null ────────────
async function getStudentChannel(studentId) {
  const mapping = await pool.query(
    "SELECT channel_id FROM student_channels WHERE student_id = $1",
    [studentId]
  );
  if (!mapping.rows.length) return null;
  return client.channels.fetch(mapping.rows[0].channel_id);
}

// ── Helper: is accountability enabled for this student? ──
async function isAccountabilityEnabled(studentId) {
  const r = await pool.query(
    "SELECT enabled FROM accountability_enabled WHERE student_id = $1",
    [studentId]
  );
  return r.rows.length > 0 && r.rows[0].enabled === true;
}

// ── Embed: completed review (split long notes) ───────────
function buildReviewEmbeds(studentName, callDate, notes, callLink, videoReviewLink) {
  const embeds = [];
  let headerText =
    `**Student:** ${studentName}\n` +
    `**Call submitted:** ${callDate}\n`;
  if (callLink)        headerText += `**Your call:** [Watch here](${callLink})\n`;
  if (videoReviewLink) headerText += `**Video review:** [Watch here](${videoReviewLink})\n`;
  headerText += "\nFull notes below 👇";

  embeds.push(
    new EmbedBuilder()
      .setTitle("📞 Your Call Review is Ready")
      .setDescription(headerText)
      .setColor(BRAND_RED)
      .setFooter({ text: "Dialled Coaching • Call Review" })
      .setTimestamp()
  );

  const chunks = [];
  let remaining = notes;
  while (remaining.length > 0) {
    if (remaining.length <= 4000) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n", 4000);
    if (splitAt < 1000) splitAt = 4000;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  for (const chunk of chunks) {
    embeds.push(new EmbedBuilder().setDescription(chunk).setColor(BRAND_RED));
  }
  return embeds;
}

// ── Embed: new call submitted ────────────────────────────
function buildSubmittedEmbed(studentName, callDate, callLink, note) {
  let desc =
    `**Student:** ${studentName}\n` +
    `**Submitted:** ${callDate}\n`;
  if (callLink) desc += `**Call:** [Watch here](${callLink})\n`;
  if (note)     desc += `\n**Note:** ${note}`;
  desc += "\n\nYour call is in the queue — review coming soon. 👀";

  return new EmbedBuilder()
    .setTitle("📥 New Call Submitted for Review")
    .setDescription(desc)
    .setColor(BRAND_RED)
    .setFooter({ text: "Dialled Coaching • Call Submitted" })
    .setTimestamp();
}

// ── Embed: accountability submitted ──────────────────────
function buildAccountabilityEmbed(studentName, data, allComplete, streak) {
  const check = (val, target) => (val >= target ? "✅" : "⏳");

  let desc =
    `**${studentName}** logged their day:\n\n` +
    `${check(data.job_apps, TARGETS.job_apps)} **Job applications:** ${data.job_apps} / ${TARGETS.job_apps}\n` +
    `${check(data.call_min, TARGETS.call_min)} **Call review:** ${data.call_min} / ${TARGETS.call_min} min\n` +
    `${check(data.roleplay_min, TARGETS.roleplay_min)} **Roleplays:** ${data.roleplay_min} / ${TARGETS.roleplay_min} min\n`;

  if (streak && streak > 0) {
    desc += `\n🔥 **${streak} day streak**\n`;
  }

  if (data.note) desc += `\n**Note:** ${data.note}`;
  desc += allComplete
    ? "\n\n🔥 All targets hit. Great work — keep the streak alive."
    : "\n\nSome targets still open for today. You've still got time. 💪";

  return new EmbedBuilder()
    .setTitle(allComplete ? "✅ Daily Accountability — All Done" : "📋 Daily Accountability Update")
    .setDescription(desc)
    .setColor(BRAND_RED)
    .setFooter({ text: "Dialled Coaching • Daily Accountability" })
    .setTimestamp();
}

// ── Embed: 9pm reminder ──────────────────────────────────
function buildReminderEmbed(studentName, reason, streak) {
  const desc = reason === "incomplete"
    ? `Hey ${studentName}, your accountability for today isn't fully complete yet. ` +
      `There's still time before the day's out — log the rest here:`
    : `Hey ${studentName}, you haven't logged your accountability today. ` +
      `Two minutes is all it takes — do it here before bed:`;

  let body = desc;
  if (streak && streak > 0) {
    body += `\n\nDon't break your **🔥 ${streak} day streak**.`;
  }
  body += `\n\n[Open your portal →](${PORTAL_URL})`;

  return new EmbedBuilder()
    .setTitle("⏰ Accountability Reminder")
    .setDescription(body)
    .setColor(BRAND_RED)
    .setFooter({ text: "Dialled Coaching • Daily Accountability" })
    .setTimestamp();
}

// ── Express ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/",       (_, res) => res.send("Dialled Call Reviews is running 📞"));
app.get("/health", (_, res) => res.json({ status: "ok" }));

// ── Call submitted ───────────────────────────────────────
app.post("/api/call-submitted", requireApiKey, async (req, res) => {
  try {
    const { student_id, student_name, call_date, call_link, note } = req.body;
    if (!student_id || !student_name) {
      return res.status(400).json({ error: "student_id and student_name are required" });
    }
    const channel = await getStudentChannel(student_id);
    if (!channel) return res.status(404).json({ error: `No Discord channel mapped for '${student_id}'.` });

    const dateText = call_date || new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
    await channel.send({ embeds: [buildSubmittedEmbed(student_name, dateText, call_link || null, note || null)] });
    await pool.query(
      "INSERT INTO review_log (student_id, student_name, call_date, event) VALUES ($1, $2, $3, 'submitted')",
      [student_id, student_name, dateText]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Call submitted error:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ── Review complete ──────────────────────────────────────
app.post("/api/review-complete", requireApiKey, async (req, res) => {
  try {
    const { student_id, student_name, call_date, notes, call_link, video_review_link } = req.body;
    if (!student_id || !student_name || !notes) {
      return res.status(400).json({ error: "student_id, student_name and notes are required" });
    }
    const channel = await getStudentChannel(student_id);
    if (!channel) return res.status(404).json({ error: `No Discord channel mapped for '${student_id}'.` });

    const dateText = call_date || new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
    const embeds = buildReviewEmbeds(student_name, dateText, notes, call_link || null, video_review_link || null);
    for (let i = 0; i < embeds.length; i += 10) {
      await channel.send({ embeds: embeds.slice(i, i + 10) });
    }
    await pool.query(
      "INSERT INTO review_log (student_id, student_name, call_date, event) VALUES ($1, $2, $3, 'review')",
      [student_id, student_name, dateText]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Review post error:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ── Accountability: enable / disable per student ─────────
// Body: { student_id, name, enabled }
app.post("/api/accountability/toggle", requireApiKey, async (req, res) => {
  try {
    const { student_id, name, enabled } = req.body;
    if (!student_id || !name || typeof enabled !== "boolean") {
      return res.status(400).json({ error: "student_id, name and enabled (boolean) are required" });
    }
    await pool.query(
      `INSERT INTO accountability_enabled (student_id, name, enabled, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (student_id) DO UPDATE SET name = $2, enabled = $3, updated_at = NOW()`,
      [student_id, name, enabled]
    );
    res.json({ success: true, enabled });
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// List enabled states (for the portal admin view)
app.get("/api/accountability/status", requireApiKey, async (_, res) => {
  try {
    const r = await pool.query("SELECT * FROM accountability_enabled ORDER BY name ASC");
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ── Accountability: daily submission ─────────────────────
// Body: { student_id, student_name, job_apps, call_min, roleplay_min, note, log_date }
app.post("/api/accountability/submit", requireApiKey, async (req, res) => {
  try {
    const { student_id, student_name, job_apps, call_min, roleplay_min, note, log_date, streak } = req.body;
    if (!student_id || !student_name) {
      return res.status(400).json({ error: "student_id and student_name are required" });
    }

    // Only fire anything if accountability is enabled for this student
    if (!(await isAccountabilityEnabled(student_id))) {
      return res.json({ success: true, skipped: "accountability not enabled for this student" });
    }

    const data = {
      job_apps:     parseInt(job_apps,     10) || 0,
      call_min:     parseInt(call_min,     10) || 0,
      roleplay_min: parseInt(roleplay_min, 10) || 0,
      note:         note || null,
    };
    const streakVal = parseInt(streak, 10) || 0;
    const allComplete =
      data.job_apps     >= TARGETS.job_apps &&
      data.call_min     >= TARGETS.call_min &&
      data.roleplay_min >= TARGETS.roleplay_min;

    const logDate = log_date || new Date().toISOString().slice(0, 10);

    // Upsert today's row (re-submitting updates it)
    await pool.query(
      `INSERT INTO accountability_log (student_id, student_name, log_date, job_apps, call_min, roleplay_min, note, streak, all_complete)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (student_id, log_date)
       DO UPDATE SET job_apps = $4, call_min = $5, roleplay_min = $6, note = $7, streak = $8, all_complete = $9`,
      [student_id, student_name, logDate, data.job_apps, data.call_min, data.roleplay_min, data.note, streakVal, allComplete]
    );

    const channel = await getStudentChannel(student_id);
    if (channel) {
      await channel.send({ embeds: [buildAccountabilityEmbed(student_name, data, allComplete, streakVal)] });
    }

    res.json({ success: true, all_complete: allComplete });
  } catch (err) {
    console.error("Accountability submit error:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ── Student ↔ channel mapping management ─────────────────
app.get("/api/students", requireApiKey, async (_, res) => {
  try {
    const result = await pool.query("SELECT * FROM student_channels ORDER BY name ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

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

app.get("/api/review-log", requireApiKey, async (_, res) => {
  try {
    const result = await pool.query("SELECT * FROM review_log ORDER BY sent_at DESC LIMIT 50");
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

// ── 9pm Sydney reminder cron ──────────────────────────────
// Runs every day at 21:00 Australia/Sydney.
cron.schedule("0 21 * * *", async () => {
  console.log("⏰ Running 9pm accountability check...");
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" }); // YYYY-MM-DD

    // Everyone who has accountability enabled
    const enabled = await pool.query(
      "SELECT student_id, name FROM accountability_enabled WHERE enabled = TRUE"
    );

    for (const student of enabled.rows) {
      // Did they submit a fully complete entry today?
      const entry = await pool.query(
        "SELECT all_complete FROM accountability_log WHERE student_id = $1 AND log_date = $2",
        [student.student_id, today]
      );

      let reason = null;
      if (!entry.rows.length) {
        reason = "missing";      // nothing submitted today
      } else if (!entry.rows[0].all_complete) {
        reason = "incomplete";   // submitted but targets not all met
      }

      if (reason) {
        // Pull their most recent known streak to use in the reminder
        const lastStreak = await pool.query(
          "SELECT streak FROM accountability_log WHERE student_id = $1 ORDER BY log_date DESC LIMIT 1",
          [student.student_id]
        );
        const streakVal = lastStreak.rows.length ? lastStreak.rows[0].streak : 0;

        const channel = await getStudentChannel(student.student_id);
        if (channel) {
          await channel.send({ embeds: [buildReminderEmbed(student.name, reason, streakVal)] });
          console.log(`Reminder sent to ${student.name} (${reason})`);
        }
      }
    }
    console.log("✅ 9pm check complete");
  } catch (err) {
    console.error("Cron error:", err);
  }
}, { timezone: "Australia/Sydney" });
