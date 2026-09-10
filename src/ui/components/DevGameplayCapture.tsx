import { useEffect, useRef, useState } from 'react';
import { AuraVideoRecorder } from '../../game/aura/AuraVideoRecorder.ts';
import { resetVirtualInput, setVirtualInputAction, type VirtualInputAction } from '../../game/systems/VirtualInput.ts';

/** Local, opt-in development capture of the actual game canvas and its HUD. */
export default function DevGameplayCapture() {
  const recorderRef = useRef<AuraVideoRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlRef = useRef<string | null>(null);
  const clipBlobRef = useRef<Blob | null>(null);
  const saveRequestRef = useRef<AbortController | null>(null);
  const inputTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const automaticInputsActiveRef = useRef(false);
  const [automaticInputs, setAutomaticInputs] = useState(false);
  const [state, setState] = useState<'idle' | 'recording' | 'processing' | 'complete' | 'error'>('idle');
  const [error, setError] = useState('');
  const [clip, setClip] = useState<{ url: string; filename: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  const releaseAutomaticInputs = () => {
    inputTimersRef.current.forEach(clearTimeout);
    inputTimersRef.current = [];
    if (automaticInputsActiveRef.current) resetVirtualInput(0);
    automaticInputsActiveRef.current = false;
  };

  const beginAutomaticInputs = () => {
    automaticInputsActiveRef.current = true;
    const at = (delay: number, action: VirtualInputAction, active: boolean) => {
      inputTimersRef.current.push(setTimeout(() => {
        if (automaticInputsActiveRef.current) setVirtualInputAction(0, action, active);
      }, delay));
    };
    const pulse = (delay: number, action: VirtualInputAction) => {
      at(delay, action, true);
      at(delay + 90, action, false);
    };
    // Feed the same input layer as touch controls. The live simulation decides
    // movement, collisions, hits and outcomes; no actor state is manufactured.
    setVirtualInputAction(0, 'right', true);
    at(7_800, 'right', false);
    pulse(1_800, 'uppercut'); // Rush maps this existing button to jump.
    for (let time = 2_700, index = 0; time < 9_800; time += 520, index += 1) {
      pulse(time, index % 5 === 4 ? 'fireball' : index % 2 === 0 ? 'punch' : 'kick');
    }
  };

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    releaseAutomaticInputs();
    recorderRef.current?.destroy();
    recorderRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    clipBlobRef.current = null;
    saveRequestRef.current?.abort();
    saveRequestRef.current = null;
  }, []);

  const saveToWorkspace = async () => {
    const blob = clipBlobRef.current;
    if (!blob || saveRequestRef.current) return;
    const controller = new AbortController();
    saveRequestRef.current = controller;
    setSaving(true);
    setSaveMessage('');
    try {
      const response = await fetch('/__dev/gameplay-capture/rush', {
        method: 'POST', mode: 'same-origin', credentials: 'omit', redirect: 'error',
        headers: { 'Content-Type': blob.type }, body: blob, signal: controller.signal,
      });
      const result = await response.json() as { path?: string; error?: string };
      if (saveRequestRef.current !== controller) return;
      if (!response.ok || typeof result.path !== 'string') throw new Error(result.error ?? 'Local save failed.');
      setSaveMessage(`Saved locally: ${result.path}`);
    } catch (error: unknown) {
      if (saveRequestRef.current === controller) setSaveMessage(error instanceof Error ? error.message : 'Local save failed.');
    } finally {
      if (saveRequestRef.current === controller) {
        saveRequestRef.current = null;
        setSaving(false);
      }
    }
  };

  const start = () => {
    if (recorderRef.current || saveRequestRef.current) return;
    const canvas = document.querySelector<HTMLCanvasElement>('#game-container canvas');
    if (!canvas) {
      setError('The game canvas is not ready.');
      setState('error');
      return;
    }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    clipBlobRef.current = null;
    setSaveMessage('');
    setClip(null);
    setError('');
    const recorder = new AuraVideoRecorder();
    const started = recorder.start(canvas); // Canvas only; no microphone or game audio.
    if (!started.ok) {
      setError(started.reason ?? 'This browser could not start recording.');
      setState('error');
      recorder.destroy();
      return;
    }
    recorderRef.current = recorder;
    setState('recording');
    if (automaticInputs) beginAutomaticInputs();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      releaseAutomaticInputs();
      setState('processing');
      void recorder.stop().then(recording => {
        if (recorderRef.current !== recorder) return;
        recorderRef.current = null;
        if (!recording) {
          setError(recorder.error ?? 'The browser could not finish the clip.');
          setState('error');
          recorder.destroy();
          return;
        }
        const url = URL.createObjectURL(recording.blob);
        urlRef.current = url;
        clipBlobRef.current = recording.blob;
        const extension = recording.mimeType.split(';', 1)[0] === 'video/mp4' ? 'mp4' : 'webm';
        setClip({ url, filename: `rush-preview-10s.${extension}` });
        setState('complete');
        recorder.destroy();
      });
    }, 10_000);
  };

  return (
    <aside className="fixed bottom-3 left-3 z-[100] max-w-[min(420px,calc(100vw-24px))] rounded border border-asf-line-strong bg-asf-bg-deep p-3 text-asf-text" aria-label="Development gameplay capture">
      <p className="mb-2 text-xs">DEV · Actual canvas + HUD · Silent clip</p>
      <label className="mb-2 flex items-center gap-2 text-xs">
        <input type="checkbox" checked={automaticInputs} onChange={event => setAutomaticInputs(event.target.checked)} disabled={state === 'recording' || state === 'processing'} />
        Automatic preview inputs
      </label>
      <button type="button" className="asf-btn asf-btn--primary" onClick={start} disabled={state === 'recording' || state === 'processing' || saving}>
        {state === 'recording' ? 'Recording 10s…' : state === 'processing' ? 'Preparing clip…' : 'Record 10s preview'}
      </button>
      <p className="mt-2 text-xs" role="status">
        {state === 'recording' ? automaticInputs ? 'Real movement and attack inputs. Capture stops automatically.' : 'Play normally. Capture stops automatically.'
          : state === 'processing' ? 'Finishing the local recording.'
            : state === 'complete' ? 'Clip ready. Preview or download below.'
              : state === 'error' ? error : 'Records the game only, without this panel.'}
      </p>
      {clip && (
        <>
          <video className="mt-2 max-h-[220px] w-full" src={clip.url} controls playsInline preload="metadata" aria-label="Captured Rush gameplay" />
          <a className="mt-2 inline-block text-sm text-asf-gold underline" href={clip.url} download={clip.filename}>Download clip</a>
          <button type="button" className="asf-btn mt-2" onClick={() => void saveToWorkspace()} disabled={saving}>
            {saving ? 'Saving locally…' : 'Save clip to workspace'}
          </button>
          {saveMessage && <p className="mt-2 break-all text-xs" role="status">{saveMessage}</p>}
        </>
      )}
    </aside>
  );
}
