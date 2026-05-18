import { useState } from 'react';

const STORAGE_KEY = 'lumina_onboarding_dismissed';

const STEPS = [
  {
    icon: '👤',
    title: 'Select a client',
    desc: 'Choose which client workspace to work in from the header.',
  },
  {
    icon: '📂',
    title: 'Upload documents',
    desc: 'Upload Workday config workbooks, SOWs, or policy docs via the Upload button.',
  },
  {
    icon: '✨',
    title: 'Run your first analysis',
    desc: 'Select a document and click Analyse, or ask Lumina a question in the chat.',
  },
];

interface Props {
  role: string;
  onDismiss: () => void;
}

export function OnboardingChecklist({ role, onDismiss }: Props) {
  const [dismissed, setDismissed] = useState(false);

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, '1');
    setDismissed(true);
    onDismiss();
  }

  if (dismissed) return null;

  const steps = role === 'client'
    ? [
        { icon: '📂', title: 'Browse your documents', desc: 'Your consultant has uploaded documents to your workspace.' },
        { icon: '✨', title: 'Ask the AI Coach', desc: 'Ask questions about your Workday configuration in the chat.' },
        { icon: '📋', title: 'Try HR Policy Advisor', desc: 'Get instant answers from your HR policies — click the Policies icon on the left.' },
      ]
    : STEPS;

  return (
    <div className="fixed bottom-6 right-6 z-50 w-80 bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden">
      <div className="bg-black px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[#86BC25] text-sm">✦</span>
          <p className="text-sm font-semibold text-white">Getting started</p>
        </div>
        <button onClick={dismiss} className="text-white/40 hover:text-white text-xs transition-colors">✕ Dismiss</button>
      </div>
      <div className="p-4 space-y-3">
        {steps.map((s, i) => (
          <div key={i} className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center text-base flex-shrink-0">{s.icon}</div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-800">{i + 1}. {s.title}</p>
              <p className="text-xs text-slate-400 mt-0.5 leading-snug">{s.desc}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="px-4 pb-4">
        <button
          onClick={dismiss}
          className="w-full py-2 text-xs font-medium text-white bg-[#86BC25] hover:bg-[#75a820] rounded-lg transition-colors"
        >
          Got it, let's go →
        </button>
      </div>
    </div>
  );
}

export function shouldShowOnboarding(): boolean {
  return !localStorage.getItem(STORAGE_KEY);
}
