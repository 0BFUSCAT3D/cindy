import React, { useState } from 'react';
import wrapAnsi from 'wrap-ansi';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';
import { Input, terminalText } from './input.js';
import { getMessages, type Locale } from './i18n.js';
import { useInputState } from './state.js';

export function InteractionView({ request, locale, resolve, back, busy }: {
  request: InteractionRequest; locale: Locale;
  resolve(decision: InteractionDecision): void; back(): void; busy: boolean;
}) {
  const t = getMessages(locale);
  const { rows,columns } = useWindowSize();
  const [selected, setSelected, selectedNow] = useInputState(0);
  const [offset, setOffset] = useState(0);
  const [questionIndex, setQuestionIndex, questionNow] = useInputState(0);
  const [answers, setAnswers, answersNow] = useInputState<Record<string, string>>({});
  const [chosen, setChosen, chosenNow] = useInputState<string[]>([]);
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState('');
  const question = request.kind === 'ask_user_question' ? request.questions[questionIndex] : undefined;
  const options = question ? [...(question.options ?? []).map(option => option.label), t.message] : [t.deny, t.approve];
  function answer(value: string) {
    const question=request.kind==='ask_user_question'?request.questions[questionNow.current]:undefined;
    if (!question) return;
    const next = { ...answersNow.current, [question.question]: value };
    if (request.kind === 'ask_user_question' && questionNow.current < request.questions.length - 1) {
      setAnswers(next); setQuestionIndex(questionNow.current + 1); setSelected(0); setChosen([]); setCustom(false); setText('');
    } else resolve({ kind: 'ask_user_question', answers: next });
  }
  useInput((input, key) => {
    if (key.eventType==='release'||busy || custom) return;
    const question=request.kind==='ask_user_question'?request.questions[questionNow.current]:undefined;
    const options=question?[...(question.options??[]).map(option=>option.label),t.message]:[t.deny,t.approve];
    if (key.escape) { back(); return; }
    if (key.pageUp) setOffset(value => Math.max(0, value - 8));
    if (key.pageDown) setOffset(value => value + 8);
    if (key.upArrow) setSelected(value => Math.max(0, value - 1));
    if (key.downArrow) setSelected(value => Math.min(options.length - 1, value + 1));
    if (question?.multiSelect && input === ' ' && selectedNow.current < options.length - 1) {
      setChosen(values => values.includes(options[selectedNow.current]) ? values.filter(value => value !== options[selectedNow.current]) : [...values, options[selectedNow.current]]);
    }
    if (!key.return) return;
    if (question) {
      if (selectedNow.current === options.length - 1) setCustom(true);
      else answer(question.multiSelect ? (chosenNow.current.length ? chosenNow.current : [options[selectedNow.current]]).join(', ') : options[selectedNow.current]);
    } else if (request.kind !== 'ask_user_question') resolve({ kind: request.kind, behavior: selectedNow.current === 1 ? 'allow' : 'deny' });
  });
  const description = request.kind === 'permission'
    ? [request.title ?? request.displayName ?? request.toolName, request.description ?? '', JSON.stringify(request.input, null, 2)].join('\n')
    : request.kind === 'plan_review' ? request.plan : question?.question ?? '';
  const lines = wrapAnsi(terminalText(description),Math.max(8,columns-2),{hard:true,trim:false}).split('\n');
  const count = Math.max(3, rows - options.length - 14);
  const start = Math.min(offset, Math.max(0, lines.length - count));
  return <Box flexDirection="column" gap={1}>
    <Text bold>{t.requests}</Text>
    <Box flexDirection="column" maxHeight={count} overflow="hidden">
      {lines.slice(start,start+count).map((line,index) => <Text key={index}>{line || ' '}</Text>)}
    </Box>
    {custom ? <Input value={text} onChange={setText} active={!busy} onSubmit={answer} onCancel={() => setCustom(false)} multiline />
      : options.map((option,index) => <Text key={index} bold={selected === index}>
        {selected === index ? '› ' : '  '}{question?.multiSelect && index < options.length - 1 ? chosen.includes(option) ? '[x] ' : '[ ] ' : ''}{terminalText(option)}
      </Text>)}
    {busy && <Text dimColor>{t.working}</Text>}
  </Box>;
}
