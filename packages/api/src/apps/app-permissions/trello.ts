import type { AppPermissionDefinition } from "./types";

export const trelloPermissions: AppPermissionDefinition = {
  provider: "trello",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_boards",
          name: "List boards",
          description: "Get all boards you have access to",
          hostPattern: "api.trello.com",
          pathPattern: "/1/members/*/boards",
          method: "GET",
        },
        {
          id: "get_board",
          name: "Get board",
          description: "Get a specific board",
          hostPattern: "api.trello.com",
          pathPattern: "/1/boards/*",
          method: "GET",
        },
        {
          id: "get_lists",
          name: "Get lists",
          description: "Get lists on a board",
          hostPattern: "api.trello.com",
          pathPattern: "/1/boards/*/lists",
          method: "GET",
        },
        {
          id: "get_cards",
          name: "Get cards",
          description: "Get cards on a board or list",
          hostPattern: "api.trello.com",
          pathPattern: "/1/lists/*/cards",
          method: "GET",
        },
        {
          id: "get_card",
          name: "Get card",
          description: "Get a specific card",
          hostPattern: "api.trello.com",
          pathPattern: "/1/cards/*",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_card",
          name: "Create card",
          description: "Create a new card",
          hostPattern: "api.trello.com",
          pathPattern: "/1/cards",
          method: "POST",
        },
        {
          id: "update_card",
          name: "Update card",
          description: "Update an existing card",
          hostPattern: "api.trello.com",
          pathPattern: "/1/cards/*",
          method: "PUT",
        },
        {
          id: "create_list",
          name: "Create list",
          description: "Create a new list on a board",
          hostPattern: "api.trello.com",
          pathPattern: "/1/lists",
          method: "POST",
        },
        {
          id: "create_board",
          name: "Create board",
          description: "Create a new board",
          hostPattern: "api.trello.com",
          pathPattern: "/1/boards",
          method: "POST",
        },
        {
          id: "delete_card",
          name: "Delete card",
          description: "Delete a card",
          hostPattern: "api.trello.com",
          pathPattern: "/1/cards/*",
          method: "DELETE",
        },
      ],
    },
  ],
};
