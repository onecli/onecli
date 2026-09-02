export const OnboardingFooter = ({
  children,
}: {
  children?: React.ReactNode;
}) => (
  <footer className="mt-auto w-full shrink-0 px-2 pt-8 pb-2 text-center">
    {children}
    <p className="text-muted-foreground text-xs">
      Secrets are encrypted at rest and in transit.
    </p>
  </footer>
);
