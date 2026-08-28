import type { AppPermissionDefinition, AppToolGroup } from "./types";

const slackGroups: AppToolGroup[] = [
  {
    category: "read",
    tools: [
      {
        id: "list_channels",
        name: "List channels",
        description: "List public and private channels in the workspace",
        hostPattern: "slack.com",
        pathPattern: "/api/conversations.list",
        methods: ["GET", "POST"],
      },
      {
        id: "channel_history",
        name: "Read channel history",
        description: "Read messages and replies in a channel",
        hostPattern: "slack.com",
        pathPattern: "/api/conversations.history",
        methods: ["GET", "POST"],
      },
      {
        id: "channel_replies",
        name: "Read thread replies",
        description: "Read replies in a message thread",
        hostPattern: "slack.com",
        pathPattern: "/api/conversations.replies",
        methods: ["GET", "POST"],
      },
      {
        id: "channel_info",
        name: "Channel info",
        description: "Get metadata about a channel",
        hostPattern: "slack.com",
        pathPattern: "/api/conversations.info",
        methods: ["GET", "POST"],
      },
      {
        id: "list_users",
        name: "List people",
        description: "List members of the workspace",
        hostPattern: "slack.com",
        pathPattern: "/api/users.list",
        methods: ["GET", "POST"],
      },
      {
        id: "user_info",
        name: "Read person",
        description: "Get profile details for a workspace member",
        hostPattern: "slack.com",
        pathPattern: "/api/users.info",
        methods: ["GET", "POST"],
      },
      {
        id: "auth_test",
        name: "Identity",
        description: "Verify the token and read the connected identity",
        hostPattern: "slack.com",
        pathPattern: "/api/auth.test",
        methods: ["GET", "POST"],
      },
    ],
  },
  {
    category: "write",
    tools: [
      {
        id: "post_message",
        name: "Send message",
        description: "Post a message to a channel, DM, or thread",
        hostPattern: "slack.com",
        pathPattern: "/api/chat.postMessage",
        method: "POST",
      },
      {
        id: "update_message",
        name: "Edit message",
        description: "Update a message the app posted",
        hostPattern: "slack.com",
        pathPattern: "/api/chat.update",
        method: "POST",
      },
      {
        id: "add_reaction",
        name: "Add reaction",
        description: "Add an emoji reaction to a message",
        hostPattern: "slack.com",
        pathPattern: "/api/reactions.add",
        method: "POST",
      },
    ],
  },
];

export const slackPermissions: AppPermissionDefinition = {
  provider: "slack",
  groups: slackGroups,
};
