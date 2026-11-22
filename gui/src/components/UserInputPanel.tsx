import { useState } from 'react';
import type { PendingUserInput, UserInputQuestion } from '../types';
import { Modal } from './Modal';

export function UserInputPanel({
  pending,
  onSubmit,
  onDecline,
}: {
  pending: PendingUserInput;
  onSubmit: (answers: Record<string, string>) => void;
  onDecline: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const allAnswered = pending.questions.every((question) => answers[question.id]?.trim());
  return (
    <Modal onClose={onDecline} labelledBy="user-input-title">
      <div className="key-card input-card">
        <div className="key-kicker">CODEX NEEDS INPUT</div>
        <h2 id="user-input-title">需要你的选择</h2>
        {pending.questions.map((question: UserInputQuestion) => (
          <div className="question" key={question.id}>
            <div className="question-header">{question.header || '问题'}</div>
            <div className="question-text">{question.question}</div>
            {question.options?.length ? (
              <div className="question-options">
                {question.options.map((option) => (
                  <button
                    key={option.label}
                    className={`question-option ${answers[question.id] === option.label ? 'selected' : ''}`}
                    title={option.description}
                    onClick={() => setAnswers({ ...answers, [question.id]: option.label })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
            <input
              type={question.isSecret ? 'password' : 'text'}
              value={answers[question.id] || ''}
              onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
              placeholder={question.isOther ? '其他答案…' : '输入答案…'}
            />
          </div>
        ))}
        <div className="key-actions">
          <button onClick={onDecline}>拒绝回答</button>
          <button className="primary" disabled={!allAnswered} onClick={() => onSubmit(answers)}>
            提交
          </button>
        </div>
      </div>
    </Modal>
  );
}
