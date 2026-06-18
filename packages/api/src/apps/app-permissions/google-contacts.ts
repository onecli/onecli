import type { AppPermissionDefinition } from "./types";

export const googleContactsPermissions: AppPermissionDefinition = {
  provider: "google-contacts",
  groups: [
    {
      category: "read",
      wildcard: {
        id: "read_all",
        name: "All read operations",
        description:
          "List, search, and read contacts, other contacts, and directory people",
        hostPattern: "people.googleapis.com",
        pathPattern: "/v1/*",
        method: "GET",
      },
      tools: [
        {
          id: "list_connections",
          name: "List contacts",
          description: "List the authenticated user's contacts",
          hostPattern: "people.googleapis.com",
          pathPattern: "/v1/people/me/connections",
          method: "GET",
        },
        {
          id: "search_contacts",
          name: "Search contacts",
          description: "Search contacts by name, email, or phone",
          hostPattern: "people.googleapis.com",
          pathPattern: "/v1/people:searchContacts",
          method: "GET",
        },
        {
          id: "get_person",
          name: "Get contact",
          description: "Retrieve a specific contact by resource name",
          hostPattern: "people.googleapis.com",
          pathPattern: "/v1/people/*",
          method: "GET",
        },
        {
          id: "list_other_contacts",
          name: "List other contacts",
          description:
            "List 'other contacts' — auto-saved people from email and calendar",
          hostPattern: "people.googleapis.com",
          pathPattern: "/v1/otherContacts",
          method: "GET",
        },
        {
          id: "search_other_contacts",
          name: "Search other contacts",
          description: "Search the 'other contacts' list",
          hostPattern: "people.googleapis.com",
          pathPattern: "/v1/otherContacts:search",
          method: "GET",
        },
        {
          id: "list_directory",
          name: "List directory people",
          description: "List people in your organization's directory",
          hostPattern: "people.googleapis.com",
          pathPattern: "/v1/people:listDirectoryPeople",
          method: "GET",
        },
        {
          id: "search_directory",
          name: "Search directory",
          description: "Search the organization's directory of coworkers",
          hostPattern: "people.googleapis.com",
          pathPattern: "/v1/people:searchDirectoryPeople",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      wildcard: {
        id: "write_all",
        name: "All write operations",
        description: "Create, update, and delete contacts",
        hostPattern: "people.googleapis.com",
        pathPattern: "/v1/*",
        methods: ["POST", "PATCH", "DELETE"],
      },
      tools: [
        {
          id: "create_contact",
          name: "Create contact",
          description: "Create a new contact",
          hostPattern: "people.googleapis.com",
          pathPattern: "/v1/people:createContact",
          method: "POST",
        },
        {
          id: "update_contact",
          name: "Update contact",
          description: "Update an existing contact",
          hostPattern: "people.googleapis.com",
          pathPattern: "/v1/people/*:updateContact",
          method: "PATCH",
        },
        {
          id: "delete_contact",
          name: "Delete contact",
          description: "Permanently delete a contact",
          hostPattern: "people.googleapis.com",
          pathPattern: "/v1/people/*:deleteContact",
          method: "DELETE",
        },
      ],
    },
  ],
};
