interface PageHeaderProps {
  title: string;
  description?: string;
}

export const PageHeader = ({ title, description }: PageHeaderProps) => (
  <div>
    <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
    {description && (
      <p className="text-muted-foreground text-sm">{description}</p>
    )}
  </div>
);
