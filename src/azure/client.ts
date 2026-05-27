import { ClientSecretCredential, DefaultAzureCredential } from "@azure/identity";
import { ContainerAppsAPIClient, type Job } from "@azure/arm-appcontainers";

export type AzureConfig = {
  subscriptionId: string;
  useManagedIdentity?: boolean;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
};

export function createAcaClient(cfg: AzureConfig): ContainerAppsAPIClient {
  const credential = cfg.useManagedIdentity
    ? new DefaultAzureCredential()
    : new ClientSecretCredential(cfg.tenantId!, cfg.clientId!, cfg.clientSecret!);
  return new ContainerAppsAPIClient(credential, cfg.subscriptionId);
}

export type CreateJobInput = {
  resourceGroup: string;
  location: string;
  environmentId: string;
  jobName: string;
  image: string;
  uamiId?: string;
  env: Record<string, string>;
};

export async function createManualJob(client: ContainerAppsAPIClient, input: CreateJobInput): Promise<void> {
  const secrets: Array<{ name: string; value: string }> = [];
  const envVars: Array<Record<string, unknown>> = [];

  for (const [name, value] of Object.entries(input.env)) {
    const lower = name.toLowerCase();
    const isSecret = lower.includes("token") || lower.includes("key") || lower.includes("secret") || lower.includes("auth");
    if (isSecret) {
      const secretName = lower.replaceAll(/[^a-z0-9-]/g, "-");
      secrets.push({ name: secretName, value });
      envVars.push({ name, secretRef: secretName });
    } else {
      envVars.push({ name, value });
    }
  }

  const acrServer = input.image.split("/")[0];

  const job: Job = {
    location: input.location,
    environmentId: input.environmentId,
    ...(input.uamiId && {
      identity: {
        type: "UserAssigned",
        userAssignedIdentities: { [input.uamiId]: {} }
      }
    }),
    configuration: {
      triggerType: "Manual",
      replicaTimeout: 7200,
      replicaRetryLimit: 0,
      secrets,
      ...(input.uamiId && {
        registries: [{ server: acrServer, identity: input.uamiId }]
      })
    },
    template: {
      containers: [
        {
          name: "worker",
          image: input.image,
          env: envVars
        }
      ]
    }
  };

  await client.jobs.beginCreateOrUpdateAndWait(input.resourceGroup, input.jobName, job);
}

export async function startJob(client: ContainerAppsAPIClient, resourceGroup: string, jobName: string): Promise<void> {
  await client.jobs.beginStartAndWait(resourceGroup, jobName);
}
