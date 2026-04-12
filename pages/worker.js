/**
 * Teacher Shen — Cloudflare Worker
 * D1 binding: DB | Secrets: GROQ_API_KEY
 * Deploy: wrangler deploy
 * Set secret: wrangler secret put GROQ_API_KEY
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const GROQ = 'https://api.groq.com/openai/v1';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── AUTH ──────────────────────────────────────────────
      if (path === '/login' && request.method === 'POST') {
        const { username, password } = await request.json();
        const user = await env.DB.prepare(
          'SELECT id, username, role, name FROM users WHERE username = ? AND password = ?'
        ).bind(username.trim(), password).first();
        if (!user) return json({ error: 'invalid' }, 401);
        return json({ ok: true, user });
      }

      // ── STUDENTS ──────────────────────────────────────────
      if (path === '/students' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT id, username, name, class_id FROM users WHERE role = "student" ORDER BY name'
        ).all();
        return json(results);
      }

      if (path === '/students' && request.method === 'POST') {
        const { username, password, name, class_id } = await request.json();
        if (!username || !password || !name) return json({ error: 'missing fields' }, 400);
        const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username.trim()).first();
        if (exists) return json({ error: 'username taken' }, 409);
        const result = await env.DB.prepare(
          'INSERT INTO users (username, password, name, role, class_id) VALUES (?, ?, ?, "student", ?)'
        ).bind(username.trim(), password, name.trim(), class_id || null).run();
        return json({ ok: true, id: result.meta.last_row_id });
      }

      if (path.startsWith('/students/') && request.method === 'POST') {
        const id = path.split('/')[2];
        const body = await request.json();
        if (body._method !== 'DELETE') return json({ error: 'bad request' }, 400);
        await env.DB.prepare('DELETE FROM users WHERE id = ? AND role = "student"').bind(id).run();
        return json({ ok: true });
      }

      // ── CLASSES ───────────────────────────────────────────
      if (path === '/classes' && request.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM classes ORDER BY name').all();
        return json(results);
      }

      if (path === '/classes' && request.method === 'POST') {
        const { name, color } = await request.json();
        const result = await env.DB.prepare(
          'INSERT INTO classes (name, color) VALUES (?, ?)'
        ).bind(name, color || '#2D6BE4').run();
        return json({ ok: true, id: result.meta.last_row_id });
      }

      // ── HOMEWORK ──────────────────────────────────────────
      if (path === '/homework' && request.method === 'GET') {
        const studentId = url.searchParams.get('student_id');
        const classId   = url.searchParams.get('class_id');

        if (studentId) {
          const { results } = await env.DB.prepare(`
            SELECT h.*, s.id as submission_id, s.status, s.recording_url,
                   s.written_answer, s.score, s.feedback, s.feedback_url,
                   s.ai_score, s.ai_feedback, s.ai_transcript, s.ai_writing
            FROM homework h
            JOIN submissions s ON s.homework_id = h.id
            WHERE s.student_id = ?
            ORDER BY h.created_at DESC
          `).bind(studentId).all();
          return json(results);
        }

        if (classId) {
          const { results } = await env.DB.prepare(
            'SELECT * FROM homework WHERE class_id = ? ORDER BY created_at DESC'
          ).bind(classId).all();
          return json(results);
        }

        const { results } = await env.DB.prepare(
          'SELECT * FROM homework ORDER BY created_at DESC'
        ).all();
        return json(results);
      }

      if (path === '/homework' && request.method === 'POST') {
        const { class_id, student_ids, title, instructions, audio_url, hw_type } = await request.json();
        if (!instructions) return json({ error: 'missing fields' }, 400);
        if (!class_id && (!student_ids || !student_ids.length)) return json({ error: 'missing class or students' }, 400);

        const hwResult = await env.DB.prepare(
          'INSERT INTO homework (class_id, title, instructions, audio_url, hw_type, created_at) VALUES (?, ?, ?, ?, ?, datetime("now"))'
        ).bind(class_id || null, title || null, instructions, audio_url || null, hw_type || 'audio').run();
        const hwId = hwResult.meta.last_row_id;

        let studentList = [];
        if (student_ids && student_ids.length) {
          studentList = student_ids.map(id => ({ id }));
        } else {
          const { results } = await env.DB.prepare(
            'SELECT id FROM users WHERE role = "student" AND class_id = ?'
          ).bind(class_id).all();
          studentList = results;
        }

        for (const s of studentList) {
          await env.DB.prepare(
            'INSERT INTO submissions (homework_id, student_id, status, created_at) VALUES (?, ?, "pending", datetime("now"))'
          ).bind(hwId, s.id).run();
        }
        return json({ ok: true, id: hwId, submissions_created: studentList.length });
      }

      // ── SUBMISSIONS ───────────────────────────────────────
      if (path === '/submissions' && request.method === 'GET') {
        const { results } = await env.DB.prepare(`
          SELECT s.*, u.name as student_name, h.instructions, h.title as hw_title, h.hw_type
          FROM submissions s
          JOIN users u ON u.id = s.student_id
          JOIN homework h ON h.id = s.homework_id
          ORDER BY s.submitted_at DESC, s.created_at DESC
        `).all();
        return json(results);
      }

      if (path.startsWith('/submissions/') && request.method === 'POST') {
        const id = path.split('/')[2];
        const body = await request.json();

        // Student submitting audio recording URL
        if (body.recording_url !== undefined) {
          await env.DB.prepare(
            'UPDATE submissions SET recording_url = ?, status = "submitted", submitted_at = datetime("now") WHERE id = ?'
          ).bind(body.recording_url, id).run();
        }

        // Student submitting written answer
        if (body.written_answer !== undefined) {
          await env.DB.prepare(
            'UPDATE submissions SET written_answer = ?, status = "submitted", submitted_at = datetime("now") WHERE id = ?'
          ).bind(body.written_answer, id).run();
        }

        // Teacher giving feedback + score (1-10 stars)
        if (body.feedback !== undefined || body.score !== undefined) {
          await env.DB.prepare(
            'UPDATE submissions SET feedback = ?, feedback_url = ?, score = ?, status = "reviewed" WHERE id = ?'
          ).bind(body.feedback || null, body.feedback_url || null, body.score || null, id).run();
        }

        // AI results (audio)
        if (body.ai_transcript !== undefined || body.ai_score !== undefined) {
          await env.DB.prepare(
            'UPDATE submissions SET ai_transcript = ?, ai_score = ?, ai_feedback = ?, status = "ai_scored" WHERE id = ?'
          ).bind(body.ai_transcript || null, body.ai_score || null, body.ai_feedback || null, id).run();
        }

        // AI results (writing)
        if (body.ai_writing !== undefined) {
          await env.DB.prepare(
            'UPDATE submissions SET ai_writing = ?, status = "ai_scored" WHERE id = ?'
          ).bind(body.ai_writing, id).run();
        }

        return json({ ok: true });
      }

      // ── TRANSCRIPTS ───────────────────────────────────────
      if (path === '/transcripts' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM transcripts ORDER BY created_at DESC LIMIT 50'
        ).all();
        return json(results);
      }

      if (path === '/transcripts' && request.method === 'POST') {
        const { text, language, duration_minutes } = await request.json();
        if (!text) return json({ error: 'no text' }, 400);
        const result = await env.DB.prepare(
          'INSERT INTO transcripts (text, language, duration_minutes, created_at) VALUES (?, ?, ?, datetime("now"))'
        ).bind(text, language || 'en', duration_minutes || null).run();
        return json({ ok: true, id: result.meta.last_row_id });
      }

      // ── AI: GENERATE HOMEWORK FROM TRANSCRIPT ─────────────
      if (path === '/ai/generate-homework' && request.method === 'POST') {
        const { transcript_id, transcript_text } = await request.json();
        let text = transcript_text;
        if (!text && transcript_id) {
          const row = await env.DB.prepare('SELECT text FROM transcripts WHERE id = ?').bind(transcript_id).first();
          text = row?.text;
        }
        if (!text) return json({ error: 'no transcript' }, 400);

        const groqRes = await fetch(`${GROQ}/chat/completions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile', max_tokens: 1200,
            messages: [
              { role: 'system', content: 'You are Teacher Shen\'s assistant. Given a lesson transcript, generate homework. Return ONLY JSON, no markdown: {"title":"short title","instructions":"detailed student instructions","hw_type":"audio","focus_areas":["area1"],"estimated_minutes":15}. hw_type must be one of: audio, written, both.' },
              { role: 'user', content: `Lesson transcript:\n\n${text.slice(0, 6000)}\n\nGenerate a homework assignment based on what was covered.` }
            ]
          })
        });
        const groqData = await groqRes.json();
        const raw = groqData.choices?.[0]?.message?.content || '{}';
        let hw;
        try { hw = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
        catch { hw = { title: 'Practice Homework', instructions: raw, hw_type: 'audio', focus_areas: [], estimated_minutes: 15 }; }
        return json({ ok: true, homework: hw });
      }

      // ── AI: WHISPER TRANSCRIPTION ─────────────────────────
      if (path === '/ai/transcribe' && request.method === 'POST') {
        const formData = await request.formData();
        const audioBlob = formData.get('audio');
        if (!audioBlob) return json({ error: 'no audio' }, 400);

        const whisperForm = new FormData();
        whisperForm.append('file', audioBlob, 'recording.webm');
        whisperForm.append('model', 'whisper-large-v3');
        whisperForm.append('response_format', 'json');

        const whisperRes = await fetch(`${GROQ}/audio/transcriptions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
          body: whisperForm
        });
        const whisperData = await whisperRes.json();
        if (!whisperData.text) return json({ error: 'transcription failed', detail: whisperData }, 500);
        return json({ ok: true, transcript: whisperData.text });
      }

      // ── AI: PRONUNCIATION SCORE ───────────────────────────
      if (path === '/ai/score-pronunciation' && request.method === 'POST') {
        const { student_transcript, expected_text, instructions } = await request.json();
        if (!student_transcript) return json({ error: 'no transcript' }, 400);

        const prompt = expected_text
          ? `Expected: "${expected_text}"\nStudent said: "${student_transcript}"`
          : `Assignment: ${instructions || 'Speaking practice'}\nStudent said: "${student_transcript}"`;

        const groqRes = await fetch(`${GROQ}/chat/completions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile', max_tokens: 800,
            messages: [
              { role: 'system', content: 'You are an English pronunciation coach for Chinese learners. Return ONLY JSON, no markdown: {"score":<0-100>,"fluency":<0-100>,"accuracy":<0-100>,"summary":"assessment","strengths":["..."],"improvements":["..."],"teacher_note":"brief note"}' },
              { role: 'user', content: prompt }
            ]
          })
        });
        const groqData = await groqRes.json();
        const raw = groqData.choices?.[0]?.message?.content || '{}';
        let scoring;
        try { scoring = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
        catch { scoring = { score: null, summary: raw, strengths: [], improvements: [] }; }
        return json({ ok: true, scoring });
      }

      // ── AI: CHECK WRITING ─────────────────────────────────
      if (path === '/ai/check-writing' && request.method === 'POST') {
        const { written_answer, instructions } = await request.json();
        if (!written_answer) return json({ error: 'no text' }, 400);

        const groqRes = await fetch(`${GROQ}/chat/completions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile', max_tokens: 900,
            messages: [
              { role: 'system', content: 'You are Teacher Shen\'s English writing assistant for Chinese learners. Evaluate the student\'s written answer. Return ONLY JSON, no markdown: {"score":<0-100>,"grammar_score":<0-100>,"vocabulary_score":<0-100>,"relevance_score":<0-100>,"summary":"overall assessment","corrections":[{"original":"...","corrected":"...","explanation":"..."}],"strengths":["..."],"improvements":["..."],"teacher_note":"brief note for teacher"}. Keep corrections concise, max 3 corrections.' },
              { role: 'user', content: `Assignment: ${instructions || 'Written English practice'}\n\nStudent wrote:\n"${written_answer}"` }
            ]
          })
        });
        const groqData = await groqRes.json();
        const raw = groqData.choices?.[0]?.message?.content || '{}';
        let analysis;
        try { analysis = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
        catch { analysis = { score: null, summary: raw, corrections: [], strengths: [], improvements: [] }; }
        return json({ ok: true, analysis });
      }

      // ── SETTINGS ──────────────────────────────────────────
      if (path === '/settings' && request.method === 'GET') {
        const row = await env.DB.prepare('SELECT * FROM settings WHERE id = 1').first();
        return json(row || {});
      }

      if (path === '/settings' && request.method === 'POST') {
        const { classin_url, next_class_time, next_class_info } = await request.json();
        await env.DB.prepare(`
          INSERT INTO settings (id, classin_url, next_class_time, next_class_info)
          VALUES (1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            classin_url = excluded.classin_url,
            next_class_time = excluded.next_class_time,
            next_class_info = excluded.next_class_info
        `).bind(classin_url, next_class_time, next_class_info).run();
        return json({ ok: true });
      }

      // ── STUDY PLAN ────────────────────────────────────────
      if (path === '/plan' && request.method === 'GET') {
        const row = await env.DB.prepare('SELECT items FROM settings WHERE id = 1').first();
        return json({ items: row?.items ? JSON.parse(row.items) : [] });
      }

      if (path === '/plan' && request.method === 'POST') {
        const { items } = await request.json();
        await env.DB.prepare(`
          INSERT INTO settings (id, items) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET items = excluded.items
        `).bind(JSON.stringify(items)).run();
        return json({ ok: true });
      }

      // ── TEACHER PASSWORD ──────────────────────────────────
      if (path === '/teacher-password' && request.method === 'POST') {
        const { password } = await request.json();
        if (!password || password.length < 6) return json({ error: 'too short' }, 400);
        await env.DB.prepare('UPDATE users SET password = ? WHERE role = "teacher"').bind(password).run();
        return json({ ok: true });
      }

      // ── IELTS STUDENTS ────────────────────────────────────
      if (path === '/ielts/students' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT id, username, name, target_band, exam_type, created_at FROM ielts_students ORDER BY name'
        ).all();
        return json(results);
      }

      if (path === '/ielts/students' && request.method === 'POST') {
        const { username, password, name, target_band, exam_type } = await request.json();
        if (!username || !password || !name) return json({ error: 'missing fields' }, 400);
        const exists = await env.DB.prepare('SELECT id FROM ielts_students WHERE username = ?').bind(username.trim()).first();
        if (exists) return json({ error: 'username taken' }, 409);
        const result = await env.DB.prepare(
          'INSERT INTO ielts_students (username, password, name, target_band, exam_type, created_at) VALUES (?, ?, ?, ?, ?, datetime("now"))'
        ).bind(username.trim(), password, name.trim(), target_band || 6.5, exam_type || 'academic').run();
        return json({ ok: true, id: result.meta.last_row_id });
      }

      if (path === '/ielts/login' && request.method === 'POST') {
        const { username, password } = await request.json();
        const student = await env.DB.prepare(
          'SELECT id, username, name, target_band, exam_type FROM ielts_students WHERE username = ? AND password = ?'
        ).bind(username.trim(), password).first();
        if (!student) return json({ error: 'invalid' }, 401);
        return json({ ok: true, student });
      }

      // ── IELTS EXAMS ───────────────────────────────────────
      if (path === '/ielts/exams' && request.method === 'GET') {
        // Auto-unpublish any expired exams
        const today = new Date().toISOString().slice(0, 10);
        await env.DB.prepare(
          "UPDATE ielts_exams SET status='draft' WHERE status='published' AND expires_at IS NOT NULL AND expires_at < ?"
        ).bind(today).run().catch(() => {});
        const status = url.searchParams.get('status');
        let query = 'SELECT id, title, exam_type, status, ai_generated, created_at, published_at, expires_at FROM ielts_exams';
        if (status) query += ` WHERE status = '${status}'`;
        query += ' ORDER BY created_at DESC';
        const { results } = await env.DB.prepare(query).all();
        return json(results);
      }

      if (path.match(/^\/ielts\/exams\/\d+$/) && request.method === 'GET') {
        const id = path.split('/')[3];
        const exam = await env.DB.prepare('SELECT * FROM ielts_exams WHERE id = ?').bind(id).first();
        if (!exam) return json({ error: 'not found' }, 404);
        return json(exam);
      }

      if (path === '/ielts/exams' && request.method === 'POST') {
        const body = await request.json();
        const result = await env.DB.prepare(`
          INSERT INTO ielts_exams (
            title, exam_type, status,
            listening_script, listening_questions,
            reading_passage1, reading_passage2, reading_passage3,
            reading_questions1, reading_questions2, reading_questions3,
            writing_task1_prompt, writing_task1_image, writing_task2_prompt,
            speaking_part1, speaking_part2, speaking_part3,
            ai_generated, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"))
        `).bind(
          body.title || 'Mock Exam',
          body.exam_type || 'academic',
          body.status || 'draft',
          body.listening_script || null,
          body.listening_questions ? JSON.stringify(body.listening_questions) : null,
          body.reading_passage1 || null,
          body.reading_passage2 || null,
          body.reading_passage3 || null,
          body.reading_questions1 ? JSON.stringify(body.reading_questions1) : null,
          body.reading_questions2 ? JSON.stringify(body.reading_questions2) : null,
          body.reading_questions3 ? JSON.stringify(body.reading_questions3) : null,
          body.writing_task1_prompt || null,
          body.writing_task1_image || null,
          body.writing_task2_prompt || null,
          body.speaking_part1 ? JSON.stringify(body.speaking_part1) : null,
          body.speaking_part2 ? JSON.stringify(body.speaking_part2) : null,
          body.speaking_part3 ? JSON.stringify(body.speaking_part3) : null,
          body.ai_generated ? 1 : 0
        ).run();
        return json({ ok: true, id: result.meta.last_row_id });
      }

      if (path.match(/^\/ielts\/exams\/\d+$/) && request.method === 'POST') {
        const id = path.split('/')[3];
        const body = await request.json();
        const fields = [];
        const values = [];
        const allowed = [
          'title','exam_type','status',
          'listening_audio_url','listening_script','listening_questions','expires_at',
          'reading_passage1','reading_passage2','reading_passage3',
          'reading_questions1','reading_questions2','reading_questions3',
          'writing_task1_prompt','writing_task1_image','writing_task2_prompt',
          'speaking_part1','speaking_part2','speaking_part3'
        ];
        for (const key of allowed) {
          if (body[key] !== undefined) {
            fields.push(`${key} = ?`);
            const val = typeof body[key] === 'object' ? JSON.stringify(body[key]) : body[key];
            values.push(val);
          }
        }
        if (body.status === 'published') {
          fields.push('published_at = datetime("now")');
        }
        if (!fields.length) return json({ error: 'nothing to update' }, 400);
        values.push(id);
        await env.DB.prepare(`UPDATE ielts_exams SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
        return json({ ok: true });
      }

      // ── IELTS AI GENERATE EXAM ────────────────────────────
      if (path === '/ielts/generate-exam' && request.method === 'POST') {
        const { exam_type, topic, difficulty } = await request.json();
        const type = exam_type || 'academic';
        const diff = difficulty || 'band 6-7';
        const generatePair = true; // Always generate A+B pair

        const prompt = `You are an expert IELTS examiner. Generate a complete IELTS ${type} mock exam on the topic: "${topic || 'environment and technology'}". Target level: ${diff}.

Return ONLY a JSON object with NO markdown, NO code blocks, exactly this structure:
{
  "title": "Mock Exam: [topic]",
  "listening_script": "A 4-part listening script (300-400 words total). Label each part: PART 1, PART 2, PART 3, PART 4",
  "listening_questions": [
    {"id":1,"part":1,"type":"form_completion","question":"The caller's name is ___","answer":"Johnson","options":null},
    {"id":2,"part":1,"type":"multiple_choice","question":"What time does the office open?","answer":"B","options":["A. 8am","B. 9am","C. 10am"]},
    {"id":3,"part":2,"type":"form_completion","question":"The event is held at ___","answer":"City Hall","options":null},
    {"id":4,"part":3,"type":"multiple_choice","question":"What does the student find most difficult?","answer":"A","options":["A. Time management","B. Research","C. Writing"]},
    {"id":5,"part":4,"type":"form_completion","question":"The process takes ___ days","answer":"fourteen","options":null}
  ],
  "reading_passage1": "A 250-word passage about a factual topic related to ${topic || 'environment'}",
  "reading_questions1": [
    {"id":1,"type":"true_false_ng","question":"The passage states that X is Y","answer":"TRUE"},
    {"id":2,"type":"true_false_ng","question":"According to the author, Z never occurs","answer":"FALSE"},
    {"id":3,"type":"true_false_ng","question":"The study was conducted in 2010","answer":"NOT GIVEN"},
    {"id":4,"type":"fill_blank","question":"The main cause of the problem is ___","answer":"pollution"},
    {"id":5,"type":"multiple_choice","question":"What is the main purpose of the passage?","answer":"B","options":["A. To warn","B. To inform","C. To persuade"]}
  ],
  "reading_passage2": "A 250-word passage on a related subtopic",
  "reading_questions2": [
    {"id":6,"type":"matching_headings","question":"Section A","answer":"iii"},
    {"id":7,"type":"matching_headings","question":"Section B","answer":"i"},
    {"id":8,"type":"fill_blank","question":"The researcher concluded that ___","answer":"further study is needed"},
    {"id":9,"type":"true_false_ng","question":"All experts agree on this finding","answer":"FALSE"},
    {"id":10,"type":"multiple_choice","question":"The word 'significant' in paragraph 2 means","answer":"A","options":["A. Important","B. Small","C. Recent"]}
  ],
  "reading_passage3": "A 250-word more complex academic passage",
  "reading_questions3": [
    {"id":11,"type":"true_false_ng","question":"The theory was first proposed in the 1990s","answer":"NOT GIVEN"},
    {"id":12,"type":"matching_headings","question":"Section C","answer":"v"},
    {"id":13,"type":"fill_blank","question":"The key finding was that ___","answer":"adaptation is essential"}
  ],
  "writing_task1_prompt": "The chart below shows [description]. Summarise the information by selecting and reporting the main features, and make comparisons where relevant. Write at least 150 words.",
  "writing_task2_prompt": "Some people believe that [statement related to topic]. To what extent do you agree or disagree? Give reasons for your answer and include any relevant examples from your own knowledge or experience. Write at least 250 words.",
  "speaking_part1": [
    {"id":1,"question":"Do you work or are you a student?"},
    {"id":2,"question":"What do you enjoy most about your work or studies?"},
    {"id":3,"question":"How do you usually spend your free time?"}
  ],
  "speaking_part2": {
    "topic": "Describe a time when you [related to topic]",
    "points": ["You should say: what it was", "when it happened", "who was involved", "and explain how you felt about it"],
    "prep_time": 60,
    "speak_time": 120
  },
  "speaking_part3": [
    {"id":1,"question":"How important is [topic] in modern society?"},
    {"id":2,"question":"Do you think the situation has changed compared to the past?"},
    {"id":3,"question":"What can governments do to address this issue?"}
  ]
}`;

        const callAI = async (p) => {
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 4000, messages: [{ role: 'user', content: p }] })
          });
          const d = await res.json();
          const raw = d.choices?.[0]?.message?.content || '{}';
          try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); }
          catch { throw new Error('AI returned invalid JSON: ' + raw.slice(0, 100)); }
        };

        // Generate Exam A and Exam B in parallel
        const promptB = prompt.replace(
          `on the topic: "${topic || 'environment and technology'}"`,
          `on the topic: "${topic || 'environment and technology'}" — this is an ALTERNATIVE version with DIFFERENT passages, questions, scripts and prompts to the first exam. Same topic and difficulty but entirely different content.`
        );

        const [examA, examB] = await Promise.all([
          callAI(prompt),
          callAI(promptB)
        ]).catch(e => { throw new Error('AI generation failed: ' + e.message); });

        return json({ ok: true, examA, examB });
      }

      // ── IELTS SUBMISSIONS ─────────────────────────────────
      if (path === '/ielts/submissions' && request.method === 'GET') {
        const examId = url.searchParams.get('exam_id');
        const studentId = url.searchParams.get('student_id');
        let query = `
          SELECT s.*, e.title as exam_title, st.name as student_name
          FROM ielts_submissions s
          JOIN ielts_exams e ON e.id = s.exam_id
          JOIN ielts_students st ON st.id = s.student_id
        `;
        const conditions = [];
        const binds = [];
        if (examId) { conditions.push('s.exam_id = ?'); binds.push(examId); }
        if (studentId) { conditions.push('s.student_id = ?'); binds.push(studentId); }
        if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY s.started_at DESC';
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return json(results);
      }

      if (path === '/ielts/submissions' && request.method === 'POST') {
        const { exam_id, student_id } = await request.json();
        if (!exam_id || !student_id) return json({ error: 'missing fields' }, 400);
        const existing = await env.DB.prepare(
          'SELECT id FROM ielts_submissions WHERE exam_id = ? AND student_id = ? AND status = "in_progress"'
        ).bind(exam_id, student_id).first();
        if (existing) return json({ ok: true, id: existing.id, resumed: true });
        const result = await env.DB.prepare(
          'INSERT INTO ielts_submissions (exam_id, student_id, status, started_at) VALUES (?, ?, "in_progress", datetime("now"))'
        ).bind(exam_id, student_id).run();
        return json({ ok: true, id: result.meta.last_row_id });
      }

      if (path.match(/^\/ielts\/submissions\/\d+$/) && request.method === 'POST') {
        const id = path.split('/')[3];
        const body = await request.json();
        const fields = [];
        const values = [];
        const allowed = [
          'listening_answers','listening_score','listening_ai_score','listening_feedback',
          'reading_answers','reading_score','reading_ai_score','reading_feedback',
          'writing_task1_answer','writing_task2_answer','writing_score','writing_ai_score','writing_ai_feedback',
          'speaking_recording_url','speaking_transcript','speaking_score','speaking_ai_score','speaking_ai_feedback',
          'overall_band','teacher_notes','status'
        ];
        for (const key of allowed) {
          if (body[key] !== undefined) {
            fields.push(`${key} = ?`);
            const val = typeof body[key] === 'object' ? JSON.stringify(body[key]) : body[key];
            values.push(val);
          }
        }
        if (body.status === 'submitted') fields.push('submitted_at = datetime("now")');
        if (body.status === 'reviewed') {
          fields.push('reviewed_at = datetime("now")');
          // Save band history
          if (body.overall_band) {
            const sub = await env.DB.prepare('SELECT student_id FROM ielts_submissions WHERE id = ?').bind(id).first();
            if (sub) {
              await env.DB.prepare(
                'INSERT INTO ielts_band_history (student_id, submission_id, listening, reading, writing, speaking, overall, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime("now"))'
              ).bind(sub.student_id, id, body.listening_score||null, body.reading_score||null, body.writing_score||null, body.speaking_score||null, body.overall_band).run();
            }
          }
        }
        if (!fields.length) return json({ error: 'nothing to update' }, 400);
        values.push(id);
        await env.DB.prepare(`UPDATE ielts_submissions SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
        return json({ ok: true });
      }

      // ── IELTS AI SCORE WRITING ────────────────────────────
      if (path === '/ielts/score-writing' && request.method === 'POST') {
        const { task1, task2, task1_prompt, task2_prompt, exam_type } = await request.json();
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 1500,
            messages: [{
              role: 'system',
              content: 'You are an expert IELTS examiner. Score writing responses using the official 4 criteria. Return ONLY JSON, no markdown.'
            }, {
              role: 'user',
              content: `Score these IELTS writing responses:

TASK 1 PROMPT: ${task1_prompt || 'Describe the chart'}
TASK 1 RESPONSE: ${task1 || '(not answered)'}

TASK 2 PROMPT: ${task2_prompt || 'Write an essay'}
TASK 2 RESPONSE: ${task2 || '(not answered)'}

Return JSON: {
  "task1": {"band": 6.5, "task_achievement": 6, "coherence": 7, "lexical": 6, "grammar": 7, "feedback": "brief feedback"},
  "task2": {"band": 6.5, "task_achievement": 6, "coherence": 7, "lexical": 6, "grammar": 7, "feedback": "brief feedback"},
  "overall_writing_band": 6.5,
  "summary": "overall writing summary",
  "improvements": ["specific improvement 1", "specific improvement 2"]
}`
            }]
          })
        });
        const groqData = await groqRes.json();
        const raw = groqData.choices?.[0]?.message?.content || '{}';
        let scoring;
        try { scoring = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
        catch { scoring = { error: 'parse failed', raw }; }
        return json({ ok: true, scoring });
      }

      // ── IELTS AI SCORE SPEAKING ───────────────────────────
      if (path === '/ielts/score-speaking' && request.method === 'POST') {
        const { transcript, questions } = await request.json();
        if (!transcript) return json({ error: 'no transcript' }, 400);
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 1000,
            messages: [{
              role: 'system',
              content: 'You are an expert IELTS speaking examiner. Score using official 4 criteria. Return ONLY JSON, no markdown.'
            }, {
              role: 'user',
              content: `Score this IELTS speaking response:
Transcript: "${transcript}"
Return JSON: {
  "band": 6.5,
  "fluency_coherence": 6.5,
  "pronunciation": 6.5,
  "lexical_resource": 6.5,
  "grammatical_range": 6.5,
  "summary": "overall speaking assessment",
  "strengths": ["strength 1"],
  "improvements": ["improvement 1"],
  "teacher_note": "note for teacher"
}`
            }]
          })
        });
        const groqData = await groqRes.json();
        const raw = groqData.choices?.[0]?.message?.content || '{}';
        let scoring;
        try { scoring = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
        catch { scoring = { error: 'parse failed', raw }; }
        return json({ ok: true, scoring });
      }

      // ── IELTS BAND HISTORY ────────────────────────────────
      if (path.match(/^\/ielts\/progress\/\d+$/) && request.method === 'GET') {
        const studentId = path.split('/')[3];
        const { results } = await env.DB.prepare(
          'SELECT * FROM ielts_band_history WHERE student_id = ? ORDER BY recorded_at ASC LIMIT 20'
        ).bind(studentId).all();
        return json(results);
      }

      return json({ error: 'not found' }, 404);

    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}
