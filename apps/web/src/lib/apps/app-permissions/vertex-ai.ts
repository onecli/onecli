import type { AppPermissionDefinition } from "./types";

export const vertexAiPermissions: AppPermissionDefinition = {
  provider: "vertex-ai",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "get_model",
          name: "Get model",
          description: "Retrieve details about a specific model",
          hostPattern: "*-aiplatform.googleapis.com",
          pathPattern: "/v1/projects/*/locations/*/models/*",
          method: "GET",
        },
        {
          id: "list_models",
          name: "List models",
          description: "List available models",
          hostPattern: "*-aiplatform.googleapis.com",
          pathPattern: "/v1/projects/*/locations/*/models",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "predict",
          name: "Predict",
          description: "Make a prediction using a deployed model",
          hostPattern: "*-aiplatform.googleapis.com",
          pathPattern: "/v1/projects/*/locations/*/endpoints/*:predict",
          method: "POST",
        },
        {
          id: "generate_content",
          name: "Generate content",
          description: "Generate content using a generative model",
          hostPattern: "*-aiplatform.googleapis.com",
          pathPattern:
            "/v1/projects/*/locations/*/publishers/*/models/*:generateContent",
          method: "POST",
        },
      ],
    },
  ],
};
