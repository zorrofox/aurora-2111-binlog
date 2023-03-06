# Welcome to Aurora MySQL 2.11.1 Binlog Testing

Aurora 2.11.1 is a version of Amazon Aurora MySQL, a relational database management system that is compatible with MySQL. The binlog (short for binary log) is a feature in Aurora that records all changes to the database so they can be replicated to other instances. Testing the binlog in Aurora 2.11.1 can help ensure that changes to the database are being properly recorded and replicated.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `cdk deploy`      deploy this stack to your default AWS account/region
* `cdk diff`        compare deployed stack with current state
* `cdk synth`       emits the synthesized CloudFormation template
