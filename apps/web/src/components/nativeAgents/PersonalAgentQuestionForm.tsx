import type { PersonalAgentAttention } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export function PersonalAgentQuestionForm({
  attention,
  disabled,
  onRespond,
}: {
  attention: Extract<PersonalAgentAttention, { kind: "question" }>;
  disabled: boolean;
  onRespond: (answers: Record<string, string[]>) => Promise<boolean>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const answerFor = (id: string) => (Object.hasOwn(answers, id) ? (answers[id] ?? "") : "");
  if (!attention.answerable)
    return (
      <div className="space-y-3">
        <p role="status" className="text-sm text-muted-foreground">
          This question can no longer receive an answer. Inspect the outcome before continuing.
        </p>
        {attention.questions.map((question) => (
          <div key={question.id} className="space-y-1 text-sm">
            <p className="font-medium">{question.header}</p>
            <p>{question.question}</p>
            {question.options?.map((option) => (
              <p key={option.label} className="text-xs text-muted-foreground">
                {option.label}: {option.description}
              </p>
            ))}
          </div>
        ))}
      </div>
    );
  const complete = attention.questions.every(
    (question) =>
      answerFor(question.id).trim() &&
      new TextEncoder().encode(answerFor(question.id)).length <= 2048,
  );
  return (
    <form
      className="space-y-3"
      aria-label="Agent questions"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !complete) return;
        const submitted = Object.fromEntries(
          attention.questions.map((question) => [question.id, [answerFor(question.id)]]),
        );
        void onRespond(submitted);
      }}
    >
      <p className="text-xs text-muted-foreground">
        {attention.isBlocking ? "Waiting for your answers" : "Your agent requested input"}
      </p>
      {attention.questions.map((question) => (
        <div key={question.id} className="space-y-2">
          <p className="text-sm font-medium">{question.header}</p>
          <p className="text-sm">{question.question}</p>
          {question.options?.length ? (
            <>
              <Select
                value={
                  question.options.some((option) => option.label === answerFor(question.id))
                    ? answerFor(question.id)
                    : null
                }
                disabled={disabled}
                onValueChange={(value) => {
                  if (typeof value === "string")
                    setAnswers((current) => ({ ...current, [question.id]: value }));
                }}
              >
                <SelectTrigger aria-label={`Choose ${question.header || question.id}`}>
                  <SelectValue placeholder="Choose an option, or write your answer" />
                </SelectTrigger>
                <SelectContent>
                  {question.options.map((option) => (
                    <SelectItem key={option.label} value={option.label}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {question.options.map((option) => (
                  <li key={option.label}>
                    {option.label}: {option.description}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <Textarea
            aria-label={`Answer ${question.header || question.id}`}
            placeholder="Write an answer, or customize your selection"
            maxLength={2048}
            value={answerFor(question.id)}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value;
              setAnswers((current) => ({ ...current, [question.id]: value }));
            }}
          />
        </div>
      ))}
      <Button size="sm" type="submit" disabled={disabled || !complete}>
        Submit answers
      </Button>
    </form>
  );
}
