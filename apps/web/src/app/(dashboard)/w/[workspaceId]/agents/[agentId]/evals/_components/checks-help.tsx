/** What the checks can and cannot tell you: shown once, below the results. */
export const ChecksHelp = () => (
  <details className="text-muted-foreground text-xs">
    <summary className="hover:text-foreground w-fit cursor-pointer rounded-sm">
      How tests are checked
    </summary>
    <div className="mt-2 max-w-prose space-y-2">
      <p>
        A number check passes when any number in the answer is within 0.5% of
        the expected one. A keyword check passes when every significant expected
        word appears; it reads words, not meaning, so it cannot tell “renewed”
        from “not renewed”.
      </p>
      <p>
        App checks look at the agent&apos;s gateway activity while the question
        ran. When that activity could belong to another run, the result is
        inconclusive rather than a failure.
      </p>
      <p>
        These checks catch changes; they do not prove an answer right. Read long
        answers yourself.
      </p>
    </div>
  </details>
);
