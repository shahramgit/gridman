import type { Item as BrunoItem } from '@usebruno/schema-types/collection/item';
import type { KeyValue as BrunoKeyValue } from '@usebruno/schema-types/common/key-value';
import type { GrpcRequest as BrunoGrpcRequest } from '@usebruno/schema-types/requests/grpc';
import type { GrpcRequest, GrpcMetadata, GrpcMessageVariant, GrpcRequestInfo, GrpcRequestDetails, GrpcRequestRuntime } from '@opencollection/types/requests/grpc';
import type { Auth } from '@opencollection/types/common/auth';
import type { Scripts } from '@opencollection/types/common/scripts';
import type { Variable } from '@opencollection/types/common/variables';
import type { Assertion } from '@opencollection/types/common/assertions';
import { stringifyYml } from '../utils';
import { isNonEmptyString, ensureString } from '../../../utils';
import { toOpenCollectionAuth } from '../common/auth';
import { toOpenCollectionVariables } from '../common/variables';
import { toOpenCollectionScripts } from '../common/scripts';
import { toOpenCollectionAssertions } from '../common/assertions';

const stringifyGrpcRequest = (item: BrunoItem): string => {
  try {
    const ocRequest: GrpcRequest = {};
    const brunoRequest = item.request as BrunoGrpcRequest;

    // info block
    const info: GrpcRequestInfo = {
      name: isNonEmptyString(item.name) ? item.name : 'Untitled Request',
      type: 'grpc'
    };
    if (item.seq) {
      info.seq = item.seq;
    }
    if (item.tags?.length) {
      info.tags = item.tags;
    }
    ocRequest.info = info;

    // grpc block
    const grpc: GrpcRequestDetails = {
      url: isNonEmptyString(brunoRequest.url) ? brunoRequest.url : '',
      method: isNonEmptyString(brunoRequest.method) ? brunoRequest.method : ''
    };

    // method type
    if (brunoRequest.methodType) {
      grpc.methodType = brunoRequest.methodType;
    }

    // proto file path
    if (isNonEmptyString(brunoRequest.protoPath)) {
      grpc.protoFilePath = brunoRequest.protoPath;
    }

    // metadata
    if (brunoRequest.headers?.length) {
      const metadata: GrpcMetadata[] = brunoRequest.headers.map((header: BrunoKeyValue) => {
        const metadataItem: GrpcMetadata = {
          name: header.name || '',
          value: header.value || ''
        };

        if (header?.description?.trim().length) {
          metadataItem.description = header.description;
        }

        if (header.enabled === false) {
          metadataItem.disabled = true;
        }

        return metadataItem;
      });

      if (metadata.length) {
        grpc.metadata = metadata;
      }
    }

    // message
    // writing only messages[0] silently dropped the rest of a streaming request on save,
    // so several messages are written as a variant list. Upstream: 240826ebc (#8203).
    // A single message keeps the scalar shape: it is what is already on disk everywhere
    // (no diff noise across git backed collections), and it is the only shape builds
    // before this change can read. The variant list is therefore limited to streaming
    // requests, which those builds could never store more than one message of anyway.
    if (brunoRequest.body?.mode === 'grpc' && brunoRequest.body.grpc?.length) {
      const messages = brunoRequest.body.grpc;

      if (messages.length === 1) {
        const message = ensureString(messages[0].content);
        if (message.trim().length) {
          grpc.message = message;
        }
      } else {
        grpc.message = messages.map(({ name, content }, index): GrpcMessageVariant => ({
          title: isNonEmptyString(name) ? name : `message ${index + 1}`,
          message: ensureString(content)
        }));
      }
    }

    // auth
    const auth: Auth | undefined = toOpenCollectionAuth(brunoRequest.auth);
    if (auth) {
      grpc.auth = auth;
    }

    ocRequest.grpc = grpc;

    // runtime block
    const runtime: GrpcRequestRuntime = {};
    let hasRuntime = false;

    // variables
    const variables: Variable[] | undefined = toOpenCollectionVariables(brunoRequest.vars);
    if (variables) {
      runtime.variables = variables;
      hasRuntime = true;
    }

    // scripts
    const scripts: Scripts | undefined = toOpenCollectionScripts(brunoRequest);
    if (scripts) {
      runtime.scripts = scripts;
      hasRuntime = true;
    }

    // assertions
    const assertions: Assertion[] | undefined = toOpenCollectionAssertions(brunoRequest.assertions);
    if (assertions) {
      runtime.assertions = assertions;
      hasRuntime = true;
    }

    if (hasRuntime) {
      ocRequest.runtime = runtime;
    }

    // docs
    if (isNonEmptyString(brunoRequest.docs)) {
      ocRequest.docs = brunoRequest.docs;
    }

    return stringifyYml(ocRequest);
  } catch (error) {
    console.error('Error stringifying gRPC request:', error);
    throw error;
  }
};

export default stringifyGrpcRequest;
