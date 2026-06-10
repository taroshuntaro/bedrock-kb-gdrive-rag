import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface KnowledgeBaseStackProps extends StackProps {
  readonly driveFolderId: string;
  readonly scheduleRate: string;
  readonly scheduleEnabled: boolean;
}

export class KnowledgeBaseStack extends Stack {
  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props);
  }
}
