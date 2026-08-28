/**
 * A submit failure on an authentication screen.
 *
 * Announced rather than toasted: the person is looking at this form, and the
 * message is about what they just typed.
 */
export const AuthFormError = ({ message }: { message: string | null }) =>
  message ? (
    <p aria-live="polite" className="text-destructive mt-4 text-center text-sm">
      {message}
    </p>
  ) : null;
