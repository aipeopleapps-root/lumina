import { useEffect, useState } from 'react';

type ToastType = 'success' | 'error' | 'info';

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onDismiss: () => void;
}

export function Toast({ message, type = 'success', duration = 4000, onDismiss }: ToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger enter animation
    const show = setTimeout(() => setVisible(true), 10);
    const hide = setTimeout(() => {
      setVisible(false);
      setTimeout(onDismiss, 300);
    }, duration);
    return () => { clearTimeout(show); clearTimeout(hide); };
  }, [duration, onDismiss]);

  const styles: Record<ToastType, string> = {
    success: 'bg-[#86BC25] text-black',
    error:   'bg-red-600 text-white',
    info:    'bg-slate-900 text-white',
  };

  const icons: Record<ToastType, string> = {
    success: '✓',
    error:   '✕',
    info:    'ℹ',
  };

  return (
    <div
      className={`fixed bottom-6 left-1/2 z-[9999] flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl text-sm font-medium transition-all duration-300 ${styles[type]} ${
        visible ? 'opacity-100 translate-y-0 -translate-x-1/2' : 'opacity-0 translate-y-4 -translate-x-1/2'
      }`}
    >
      <span className="w-5 h-5 rounded-full bg-black/10 flex items-center justify-center text-xs font-bold shrink-0">
        {icons[type]}
      </span>
      <span>{message}</span>
      <button onClick={() => { setVisible(false); setTimeout(onDismiss, 300); }} className="ml-2 opacity-60 hover:opacity-100 transition-opacity text-xs">✕</button>
    </div>
  );
}

// Simple manager — renders one toast at a time from parent state
export interface ToastState {
  message: string;
  type: ToastType;
  id: number;
}

export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  let _counter = 0;

  function showToast(message: string, type: ToastType = 'success') {
    setToast({ message, type, id: ++_counter });
  }

  function dismissToast() {
    setToast(null);
  }

  return { toast, showToast, dismissToast };
}
