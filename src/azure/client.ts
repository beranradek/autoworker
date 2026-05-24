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
  env: Record<string, string>;
};

export async function createManualJob(client: ContainerAppsAPIClient, input: CreateJobInput): Promise<void> {
  const envVars = Object.entries(input.env).map(([name, value]) => ({ name, value }));

  const job: Job = {
    location: input.location,
    properties: {
      environmentId: input.environmentId,
      configuration: {
        triggerType: "Manual",
        replicaTimeout: 7200,
        replicaRetryLimit: 0
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
    } as any
  } as any;

  await client.jobs.beginCreateOrUpdateAndWait(input.resourceGroup, input.jobName, job);
}

export async function startJob(client: ContainerAppsAPIClient, resourceGroup: string, jobName: string): Promise<void> {
  await client.jobs.beginStartAndWait(resourceGroup, jobName);
}
