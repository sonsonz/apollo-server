import { expect } from 'chai';
import 'mocha';
import micro from 'micro';
import * as listen from 'test-listen';
import { createApolloFetch } from 'apollo-fetch';
import { gql } from 'apollo-server-core';
import * as FormData from 'form-data';
import * as fs from 'fs';
import * as rp from 'request-promise';

import { ApolloServer } from './ApolloServer';

const typeDefs = gql`
  type Query {
    hello: String
  }
`;

const resolvers = {
  Query: {
    hello: () => 'hi',
  },
};

async function createServer(options: object = {}): Promise<any> {
  const apolloServer = new ApolloServer({ typeDefs, resolvers });
  const service = micro(apolloServer.createHandler(options));
  const uri = await listen(service);
  return {
    service,
    uri,
  };
}

describe('apollo-server-micro', function() {
  describe('constructor', function() {
    it('should accepts typeDefs and resolvers', function() {
      const apolloServer = new ApolloServer({ typeDefs, resolvers });
      expect(apolloServer).to.not.be.undefined;
    });
  });

  describe('#createHandler', function() {
    describe('querying', function() {
      it(
        'should be queryable using the default /graphql path, if no path ' +
          'is provided',
        async function() {
          const { service, uri } = await createServer();
          const apolloFetch = createApolloFetch({ uri: `${uri}/graphql` });
          const result = await apolloFetch({ query: '{hello}' });
          expect(result.data.hello).to.equal('hi');
          service.close();
        },
      );

      it(
        'should only be queryable at the default /graphql path, if no path ' +
          'is provided',
        async function() {
          const { service, uri } = await createServer();
          const apolloFetch = createApolloFetch({ uri: `${uri}/nopath` });
          let errorThrown = false;
          try {
            await apolloFetch({ query: '{hello}' });
          } catch (error) {
            errorThrown = true;
          }
          expect(errorThrown).to.be.true;
          service.close();
        },
      );

      it('should be queryable using a custom path', async function() {
        const { service, uri } = await createServer({ path: '/data' });
        const apolloFetch = createApolloFetch({ uri: `${uri}/data` });
        const result = await apolloFetch({ query: '{hello}' });
        expect(result.data.hello).to.equal('hi');
        service.close();
      });

      it(
        'should render a GraphQL playground when a browser sends in a ' +
          'request',
        async function() {
          const nodeEnv = process.env.NODE_ENV;
          delete process.env.NODE_ENV;

          const { service, uri } = await createServer();

          const body = await rp({
            uri,
            method: 'GET',
            headers: {
              accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            },
          });
          process.env.NODE_ENV = nodeEnv;
          expect(body).to.contain('GraphQLPlayground');
          service.close();
        },
      );
    });

    describe('health checks', function() {
      it('should create a healthcheck endpoint', async function() {
        const { service, uri } = await createServer();
        const body = await rp(`${uri}/.well-known/apollo/server-health`);
        expect(body).to.equal(JSON.stringify({ status: 'pass' }));
        service.close();
      });

      it('should support a health check callback', async function() {
        const { service, uri } = await createServer({
          async onHealthCheck() {
            throw Error("can't connect to DB");
          },
        });

        let error;
        try {
          await rp(`${uri}/.well-known/apollo/server-health`);
        } catch (err) {
          error = err;
        }
        expect(error).to.not.be.undefined;
        expect(error.statusCode).to.equal(503);
        expect(error.error).to.equal(JSON.stringify({ status: 'fail' }));
        service.close();
      });

      it('should be able to disable the health check', async function() {
        const { service, uri } = await createServer({
          disableHealthCheck: true,
        });

        let error;
        try {
          await rp(`${uri}/.well-known/apollo/server-health`);
        } catch (err) {
          error = err;
        }
        expect(error).to.not.be.undefined;
        expect(error.statusCode).to.equal(404);
        service.close();
      });
    });

    describe('file uploads', function() {
      it('should handle file uploads', async function() {
        // XXX This is currently a failing test for node 10
        const NODE_VERSION = process.version.split('.');
        const NODE_MAJOR_VERSION = parseInt(NODE_VERSION[0].replace(/^v/, ''));
        if (NODE_MAJOR_VERSION === 10) return;

        const apolloServer = new ApolloServer({
          typeDefs: gql`
            type File {
              filename: String!
              mimetype: String!
              encoding: String!
            }

            type Query {
              uploads: [File]
            }

            type Mutation {
              singleUpload(file: Upload!): File!
            }
          `,
          resolvers: {
            Query: {
              uploads: () => {},
            },
            Mutation: {
              singleUpload: async (_, args) => {
                expect((await args.file).stream).to.exist;
                return args.file;
              },
            },
          },
        });
        const service = micro(apolloServer.createHandler());
        const url = await listen(service);

        const body = new FormData();
        body.append(
          'operations',
          JSON.stringify({
            query: `
              mutation($file: Upload!) {
                singleUpload(file: $file) {
                  filename
                  encoding
                  mimetype
                }
              }
            `,
            variables: {
              file: null,
            },
          }),
        );
        body.append('map', JSON.stringify({ 1: ['variables.file'] }));
        body.append('1', fs.createReadStream('package.json'));

        try {
          const resolved = await fetch(`${url}/graphql`, {
            method: 'POST',
            body: body as any,
          });
          const text = await resolved.text();
          const response = JSON.parse(text);

          expect(response.data.singleUpload).to.deep.equal({
            filename: 'package.json',
            encoding: '7bit',
            mimetype: 'application/json',
          });
        } catch (error) {
          // This error began appearing randomly and seems to be a dev
          // dependency bug.
          // https://github.com/jaydenseric/apollo-upload-server/blob/18ecdbc7a1f8b69ad51b4affbd986400033303d4/test.js#L39-L42
          if (error.code !== 'EPIPE') throw error;
        }

        service.close();
      });
    });
  });
});
