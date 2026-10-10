import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Check,
  Repeat2,
  Shield,
} from "lucide-react"
import { useMemo, useState } from "react"
import { personas } from "../data/demo"
import type { PersonaId } from "../types"
import Brand from "./Brand"
import { Badge, Button, Card } from "./ui"
import { APP_NAME } from "@sqw/brand"

const questions = [
  {
    label: `What brings you to ${APP_NAME}?`,
    options: [
      { value: "preserve", label: "Preserve long-term holdings" },
      { value: "trade", label: "Trade regularly" },
      { value: "speed", label: "Execute at high frequency" },
    ],
  },
  {
    label: "How often do you transact?",
    options: [
      { value: "monthly", label: "A few times a month" },
      { value: "weekly", label: "Several times a week" },
      { value: "daily", label: "Many times a day" },
    ],
  },
  {
    label: "What is your typical transaction size?",
    options: [
      { value: "small", label: "Below $10,000" },
      { value: "medium", label: "$10,000–$250,000" },
      { value: "large", label: "Above $250,000" },
    ],
  },
]

function recommendPersona(answers: string[]): PersonaId {
  if (answers.includes("speed") || answers.includes("daily")) return "frequency"
  if (
    answers.includes("trade") ||
    answers.includes("weekly") ||
    answers.includes("medium")
  )
    return "active"
  return "holder"
}

export default function ProfileSetup({
  initialPersona,
  onBack,
  onComplete,
}: {
  initialPersona: PersonaId
  onBack: () => void
  onComplete: (persona: PersonaId) => void
}) {
  const [answers, setAnswers] = useState(["preserve", "monthly", "small"])
  const [selected, setSelected] = useState<PersonaId>(initialPersona)
  const recommended = useMemo<PersonaId>(
    () => recommendPersona(answers),
    [answers],
  )

  const updateAnswer = (index: number, value: string) => {
    const next = [...answers]
    next[index] = value
    setAnswers(next)
    setSelected(recommendPersona(next))
  }

  return (
    <div className="profile-page">
      <header className="profile-header">
        <Brand />
        <Badge tone="low">
          <Check size={14} /> Identity verified
        </Badge>
      </header>
      <main className="profile-layout">
        <button className="back-link inline-back" onClick={onBack}>
          <ArrowLeft size={17} /> Back
        </button>
        <div className="profile-intro">
          <span className="eyebrow">PERSONALISE YOUR RISK ANALYSIS</span>
          <h1>How do you use crypto?</h1>
          <p>
            Your profile helps {APP_NAME} distinguish a normal transaction from one
            that deserves a closer look. You can change this later.
          </p>
        </div>
        <div className="profile-content">
          <Card className="question-card">
            {questions.map((question, questionIndex) => (
              <fieldset key={question.label} className="question-group">
                <legend>
                  <span>{questionIndex + 1}</span>
                  {question.label}
                </legend>
                <div className="option-grid">
                  {question.options.map((option) => (
                    <label
                      key={option.value}
                      className={
                        answers[questionIndex] === option.value
                          ? "choice active"
                          : "choice"
                      }
                    >
                      <input
                        type="radio"
                        name={`question-${questionIndex}`}
                        value={option.value}
                        checked={answers[questionIndex] === option.value}
                        onChange={() =>
                          updateAnswer(questionIndex, option.value)
                        }
                      />
                      <span>{option.label}</span>
                      {answers[questionIndex] === option.value && (
                        <Check size={16} />
                      )}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </Card>

          <div className="persona-column">
            <div className="recommendation-heading">
              <span className="eyebrow">YOUR RISK PROFILE</span>
              <Badge tone="brand">
                Recommended:{" "}
                {personas.find((item) => item.id === recommended)?.shortName}
              </Badge>
            </div>
            <div className="persona-options">
              {personas.map((persona, index) => {
                const icons = [<Shield />, <BarChart3 />, <Repeat2 />]
                return (
                  <button
                    key={persona.id}
                    className={
                      selected === persona.id
                        ? "persona-card selected"
                        : "persona-card"
                    }
                    onClick={() => setSelected(persona.id)}
                  >
                    <span className="persona-icon">{icons[index]}</span>
                    <span className="persona-copy">
                      <strong>{persona.name}</strong>
                      <small>{persona.description}</small>
                    </span>
                    <span className="radio-indicator">
                      {selected === persona.id && <Check size={14} />}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="profile-impact">
              <strong>{APP_NAME} will prioritise</strong>
              <span>
                {personas.find((persona) => persona.id === selected)?.emphasis}
              </span>
            </div>
            <Button
              size="lg"
              className="full-width"
              onClick={() => onComplete(selected)}
              icon={<ArrowRight size={18} />}
            >
              Open my {APP_NAME} wallet
            </Button>
          </div>
        </div>
      </main>
    </div>
  )
}
