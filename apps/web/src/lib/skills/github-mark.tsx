import { AppIcon } from "@/lib/components/app-icon";

export interface GitHubMarkProps {
  size?: number;
}

/** The GitHub mark, from the same icons the github-app integration uses
 * (with its dark-mode variant). */
export const GitHubMark = ({ size = 20 }: GitHubMarkProps) => (
  <AppIcon
    icon="/icons/github.svg"
    darkIcon="/icons/github-light.svg"
    name="GitHub"
    size={size}
  />
);
