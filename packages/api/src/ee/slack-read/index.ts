import { oauthUserAccess } from "@onecli/channels/slack";
import type {
  ConversationReader,
  UserReadConnectCompleter,
} from "../../providers/hooks/conversation-reader";
import { verifyOAuthState } from "../../lib/oauth-state";
import { hasActiveMembership } from "../../middleware/auth/resolve";
import { ServiceError } from "../../services/errors";
import { completeConnect, isUserReadState, readConversation } from "./service";

/** The injected `read_conversation` body (see providers/hooks). */
export const eeConversationReader: ConversationReader = {
  read: (input) => readConversation(input),
};

/** The injected "Connect your Slack" OAuth return. The signature is
 * verified HERE, before anything in the state is trusted. */
export const eeUserReadConnectCompleter: UserReadConnectCompleter = {
  handles: isUserReadState,
  complete: async ({ state, code, redirectUri }) => {
    const payload = verifyOAuthState(state);
    if (!payload) {
      throw new ServiceError(
        "UNPROCESSABLE",
        "This connect link is not valid.",
      );
    }
    return completeConnect({
      state: payload,
      code,
      redirectUri,
      exchange: oauthUserAccess,
      isActiveMember: hasActiveMembership,
    });
  },
};

export { slackReadOverviewRoutes, slackReadRoutes } from "./routes";
