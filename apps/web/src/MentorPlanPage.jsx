/**
 * Public mentor plan completion — the link an external mentor receives by email.
 *
 * No auth: the token in the query string is the whole credential and self-describes
 * its tenant and the check-in it completes. The mentor works through the same plan
 * wizard the office uses, submits, and sees the summary — all in isolation.
 */
import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import * as api from './api.js';
import { Btn } from './atoms.jsx';
import { AdpWizard, AdpDetail } from './academic.jsx';
import './academic.css';

export function MentorPlanPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t');

  const [plan, setPlan] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [completed, setCompleted] = useState(null); // the submitted plan, for the summary
  const [showSummary, setShowSummary] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);

  useEffect(() => {
    let live = true;
    if (!token) {
      setLoadError('This link is missing its token.');
      return;
    }
    api
      .getMentorPlan(id, token)
      .then((p) => live && setPlan(p))
      .catch((e) => live && setLoadError(e.message || 'This link is not valid.'));
    return () => {
      live = false;
    };
  }, [id, token]);

  if (loadError) {
    return (
      <div className="mentor-page">
        <div className="mentor-card">
          <h1>Link not available</h1>
          <p className="muted">{loadError}</p>
          <p className="muted">Please ask the sport office to resend your link.</p>
        </div>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="mentor-page">
        <div className="mentor-card">
          <div className="muted">Loading the plan…</div>
        </div>
      </div>
    );
  }

  // Already completed (or just completed) → show the summary.
  const already = plan.planStatus === 'completed' && !completed;
  const summaryCheckIn = completed
    ? {
        ...completed,
        athleteName: plan.athleteName,
        studentNumber: plan.studentNumber,
        period: plan.period,
        kind: 'adp',
        planStatus: 'completed',
      }
    : { ...plan, kind: 'adp', planStatus: 'completed' };

  if (completed || already) {
    return (
      <div className="mentor-page">
        {showSummary && (
          <AdpDetail checkIn={summaryCheckIn} athletes={[]} onClose={() => setShowSummary(false)} />
        )}
        <div className="mentor-card">
          <div className="mentor-eyebrow">Academic development plan</div>
          <h1>Thank you{plan.mentor ? `, ${plan.mentor.split(' ')[0]}` : ''}.</h1>
          <p>
            {already ? 'This plan has already been completed' : 'The plan has been submitted'} for{' '}
            <strong>{plan.athleteName}</strong>
            {plan.period ? ` · ${plan.period}` : ''}. The sport office has it — no further action is
            needed.
          </p>
          <Btn tone="primary" onClick={() => setShowSummary(true)}>
            View the summary
          </Btn>
          <div className="mentor-report-link">
            <span className="muted">
              Report link — the student and mentor can open this any time, no login:
            </span>
            <input
              readOnly
              value={`${window.location.origin}${import.meta.env.BASE_URL}#/report/${id}?t=${token}`}
              onFocus={(e) => e.target.select()}
            />
          </div>
        </div>
      </div>
    );
  }

  // Split the stored full name for the wizard header.
  const [firstName, ...rest] = (plan.athleteName ?? '').split(' ');
  const athlete = {
    firstName,
    lastName: rest.join(' '),
    faculty: plan.faculty,
    degree: plan.degree,
    studentNumber: plan.studentNumber,
  };

  async function submit(payload) {
    await api.submitMentorPlan(id, token, payload);
    setCompleted(payload);
    setShowSummary(true);
  }
  async function saveDraft(payload) {
    await api.submitMentorPlan(id, token, { ...payload, status: 'draft' });
    setPlan((p) => ({ ...p, ...payload, planStatus: 'draft' }));
    setDraftSaved(true);
    window.scrollTo(0, 0);
  }

  // Draft saved — a clear "you can stop here and come back" confirmation.
  if (draftSaved) {
    return (
      <div className="mentor-page">
        <div className="mentor-card">
          <div className="mentor-eyebrow">Academic development plan</div>
          <h1>Draft saved.</h1>
          <p>
            Your progress on <strong>{plan.athleteName}</strong>’s plan is saved. You can close this
            page and come back to <strong>the same link</strong> any time to finish it.
          </p>
          <Btn tone="primary" onClick={() => setDraftSaved(false)}>
            Continue now
          </Btn>
        </div>
      </div>
    );
  }

  const resuming = plan.planStatus === 'draft';

  return (
    <div className="mentor-page mentor-wizard-page">
      <div className="mentor-intro">
        <div className="mentor-eyebrow">Academic development plan</div>
        <h1>
          {plan.athleteName}
          {plan.period ? <span className="muted"> · {plan.period}</span> : null}
        </h1>
        <p className="muted">
          {resuming
            ? `Picking up where you left off with ${firstName || 'the student'}. Finish the plan and submit — or save a draft again. No login.`
            : `You’ve been asked to complete this plan with ${firstName || 'the student'}. Work through it together, then submit — it goes straight to the sport office. You can also save a draft and come back later. Nothing to install, no login.`}
        </p>
      </div>
      <div className="mentor-wizard">
        <AdpWizard
          athlete={athlete}
          period={plan.period}
          initial={{
            modules: plan.modules,
            sections: plan.sections,
            plan: plan.plan,
            note: plan.note,
            scheduledNext: plan.scheduledNext,
          }}
          editing={resuming}
          onSubmit={submit}
          onSaveDraft={saveDraft}
          onClose={() => window.scrollTo(0, 0)}
        />
      </div>
    </div>
  );
}
