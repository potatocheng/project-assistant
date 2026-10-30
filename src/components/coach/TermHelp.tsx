import { Fragment, useState } from 'react';
import { Dialog } from '../ui';
import { TERMS, type Term } from './coach-model';
import './coach.css';

export function TermHelp({ term, label, context }: { term: Term; label?: string; context?: string }) {
  const [open, setOpen] = useState(false);
  const info = TERMS[term];
  return <><button type="button" className="term-help" aria-label={`解释${term}`} onClick={() => setOpen(true)}>{label ?? term}<span aria-hidden="true">?</span></button>{open && <Dialog title={term} subtitle="一句话看懂，再做下一步" close={() => setOpen(false)}><div className="dialog-body term-explanation"><p>{info.plain}</p><p className="field-hint">{info.example}</p>{context && <p>回到「{context}」</p>}<strong>你可以先这样做</strong><p>{info.action}</p></div><div className="dialog-footer"><button type="button" className="button primary" onClick={() => setOpen(false)}>明白了，继续做事</button></div></Dialog>}</>;
}

const pattern = new RegExp(`(${Object.keys(TERMS).join('|')})`, 'g');
export function ExplainedText({ text, context }: { text: string; context?: string }) {
  return <>{text.split(pattern).map((part, i) => <Fragment key={i}>{Object.hasOwn(TERMS, part) ? <TermHelp term={part as Term} context={context} /> : part}</Fragment>)}</>;
}
