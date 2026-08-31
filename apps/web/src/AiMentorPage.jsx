/**
 * AI mentor session — the public, no-login page where an AI voice agent walks the
 * student through their academic development plan in place of a human mentor.
 *
 * Same token-gated link as the human mentor page. If ElevenLabs is configured it
 * runs a live voice agent; otherwise it runs the scripted mock (voice via the
 * browser's speech synthesis) so the concept is fully demonstrable with no key.
 * Either way the agent's tool calls build the plan and it's submitted through the
 * normal mentor-plan API.
 */
import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import * as api from './api.js';
import { Btn, Icon } from './atoms.jsx';
import { makeCollector, mockMentorScript } from './aiMentor.js';
import { elevenLabsConfigured, startElevenLabsSession } from './aiMentorElevenLabs.js';
import { ADP_SECTION_META } from './academic-model.js';
import './academic.css';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function speak(text, muted) {
  if (muted || typeof speechSynthesis === 'undefined') return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[“”"]/g, ''));
    u.rate = 1.03;
    speechSynthesis.speak(u);
  } catch {
    /* no voice available */
  }
}

export function AiMentorPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t');

  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [phase, setPhase] = useState('intro'); // intro | running | submitting | done | error
  const [muted, setMuted] = useState(false);
  const [messages, setMessages] = useState([]);
  const [choices, setChoices] = useState(null);
  const [speaking, setSpeaking] = useState(false);
  const [, force] = useState(0); // re-render when the live plan mutates

  const sess = useRef(null); // { tools, buildPayload, collected }
  const gen = useRef(null);
  const elCtl = useRef(null);
  const submitted = useRef(false);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  useEffect(() => {
    if (!token) return setError('This link is missing its token.');
    let live = true;
    api
      .getMentorPlan(id, token)
      .then((p) => live && setPlan(p))
      .catch((e) => live && setError(e.message || 'This link is not valid.'));
    return () => {
      live = false;
      try {
        elCtl.current?.end?.();
        speechSynthesis?.cancel?.();
      } catch {
        /* ignore */
      }
    };
  }, [id, token]);

  if (error || (plan && plan.planStatus === 'completed' && phase === 'intro')) {
    const done = plan?.planStatus === 'completed';
    return (
      <div className="mentor-page">
        <div className="mentor-card">
          <h1>{done ? 'Already completed' : 'Session not available'}</h1>
          <p className="muted">
            {done
              ? `${plan.athleteName}'s plan has already been completed.`
              : error || 'This link is not valid.'}
          </p>
        </div>
      </div>
    );
  }
  if (!plan) {
    return (
      <div className="mentor-page">
        <div className="mentor-card">
          <div className="muted">Loading your session…</div>
        </div>
      </div>
    );
  }

  const firstName = (plan.athleteName ?? '').split(' ')[0];

  function buildCtx() {
    return {
      firstName,
      period: plan.period,
      modules: plan.modules ?? [],
      suggestedNext: new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10),
    };
  }

  async function doSubmit() {
    if (submitted.current) return;
    submitted.current = true;
    setPhase('submitting');
    try {
      await api.submitMentorPlan(id, token, sess.current.buildPayload());
      setPhase('done');
    } catch (e) {
      setError(e.message || 'Could not save the plan.');
      setPhase('error');
    }
  }

  function initSession() {
    const ctx = buildCtx();
    const collector = makeCollector(ctx);
    // Wrap submit_plan so the agent finishing the plan actually persists it.
    const origSubmit = collector.tools.submit_plan;
    collector.tools.submit_plan = (p) => {
      const r = origSubmit(p);
      doSubmit();
      return r;
    };
    // Re-render the live panel whenever a tool records something.
    for (const [k, fn] of Object.entries(collector.tools)) {
      collector.tools[k] = (p) => {
        const r = fn(p);
        force((n) => n + 1);
        return r;
      };
    }
    sess.current = { ...collector, ctx };
    return sess.current;
  }

  async function startSession() {
    const s = initSession();
    setPhase('running');
    if (elevenLabsConfigured()) {
      // Production: live ElevenLabs voice agent drives the tools.
      try {
        elCtl.current = await startElevenLabsSession(s.ctx, s.tools, {
          onMessage: (m) => setMessages((xs) => [...xs, m]),
          onState: (st) => setSpeaking(st === 'speaking'),
          onError: (e) => setError(e.message || 'Voice session error.'),
        });
      } catch (e) {
        setError(e.message || 'Could not start the AI mentor.');
        setPhase('error');
      }
      return;
    }
    // Demo: scripted mock agent + speech synthesis.
    gen.current = mockMentorScript(s.ctx, s.tools);
    advance();
  }

  async function advance(answer) {
    const { value, done } = await gen.current.next(answer);
    if (done) {
      if (!submitted.current) doSubmit();
      return;
    }
    setMessages((xs) => [...xs, { role: 'mentor', text: value.text }]);
    setSpeaking(true);
    speak(value.text, mutedRef.current);
    if (value.choices?.length) {
      setChoices(value.choices);
      setSpeaking(false);
    } else {
      setChoices(null);
      await delay(Math.min(4200, 1100 + value.text.length * 32));
      setSpeaking(false);
      advance();
    }
  }

  function pick(choice) {
    setMessages((xs) => [...xs, { role: 'student', text: choice }]);
    setChoices(null);
    advance(choice);
  }

  const collected = sess.current?.collected;

  // Thank-you.
  if (phase === 'done') {
    const link = `${window.location.origin}${import.meta.env.BASE_URL}#/report/${id}?t=${token}`;
    return (
      <div className="mentor-page">
        <div className="mentor-card">
          <div className="ai-badge">
            <Icon.Live /> AI mentor
          </div>
          <h1>All done, {firstName}!</h1>
          <p>
            Thanks for talking it through. Your plan is saved and the sport office has it. Open your
            report any time to see it and tick off your actions.
          </p>
          <label className="fld">
            <span>Your report link</span>
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
          </label>
          <a className="btn btn-primary" href={link}>
            Open my plan
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="mentor-page ai-page">
      <div className="mentor-intro">
        <div className="ai-badge">
          <Icon.Live /> AI academic mentor
          {!elevenLabsConfigured() && <span className="ai-demo-tag">demo voice</span>}
        </div>
        <h1>
          {plan.athleteName}
          {plan.period ? <span className="muted"> · {plan.period}</span> : null}
        </h1>
        <p className="muted">
          An AI mentor will talk you through a quick academic check-in and set up your support — no
          login. A real person from the office reviews every plan.
        </p>
      </div>

      <div className="ai-grid">
        <div className="ai-convo-card">
          <div className="ai-convo-head">
            <span className={`ai-orb ${speaking ? 'on' : ''}`}>
              <span />
              <span />
              <span />
            </span>
            <span className="muted">{phase === 'running' ? (speaking ? 'Mentor speaking…' : 'Your turn') : 'Ready'}</span>
            <button
              type="button"
              className="ai-mute"
              onClick={() => setMuted((m) => !m)}
              aria-label={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? 'Unmute 🔇' : 'Mute 🔊'}
            </button>
          </div>

          {phase === 'intro' ? (
            <div className="ai-start">
              <p className="muted">
                It’s a friendly, spoken conversation — you can tap your answers. Ready when you are.
              </p>
              <Btn tone="primary" icon={Icon.Live} onClick={startSession}>
                Start the session
              </Btn>
            </div>
          ) : (
            <>
              <div className="ai-messages">
                {messages.map((m, i) => (
                  <div key={i} className={`ai-msg ai-${m.role}`}>
                    {m.text}
                  </div>
                ))}
                {phase === 'submitting' && <div className="ai-msg ai-mentor">Saving your plan…</div>}
              </div>
              {choices && (
                <div className="ai-choices">
                  {choices.map((c) => (
                    <button key={c} type="button" className="ai-choice" onClick={() => pick(c)}>
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="ai-plan-card">
          <div className="ai-plan-title">Your plan, building live</div>
          {!collected || Object.keys(collected.screener).length + Object.keys(collected.areas).length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>
              As you talk, what you agree shows up here.
            </p>
          ) : (
            <div className="ai-plan-body">
              {Object.keys(collected.screener).length > 0 && (
                <div className="ai-plan-sec">
                  <span className="ai-plan-lbl">Modules</span>
                  {Object.keys(collected.screener).join(', ')}
                </div>
              )}
              {Object.entries(collected.areas).map(([k, v]) => (
                <div key={k} className="ai-plan-sec">
                  <span className="ai-plan-lbl">{ADP_SECTION_META[k]?.title ?? k}</span>
                  {v.score} / 5
                </div>
              ))}
              {collected.actions.length > 0 && (
                <div className="ai-plan-sec">
                  <span className="ai-plan-lbl">Actions</span>
                  <ul className="ai-plan-actions">
                    {collected.actions.map((a, i) => (
                      <li key={i}>{a.text}</li>
                    ))}
                  </ul>
                </div>
              )}
              {collected.wellbeing.length > 0 && (
                <div className="ai-plan-sec ai-plan-flag">
                  <span className="ai-plan-lbl">Flagged for a person</span>
                  wellbeing follow-up
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
