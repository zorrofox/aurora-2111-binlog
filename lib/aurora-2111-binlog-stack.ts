import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as msk from '@aws-cdk/aws-msk-alpha';
import * as mskCfn from 'aws-cdk-lib/aws-msk';
import * as dms from 'aws-cdk-lib/aws-dms';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';

export class Aurora2111BinlogStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Aurora DB Testing VPC', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      natGateways: 1,
    });

    const instanceSg = new ec2.SecurityGroup(this, 'MySQL Client SG', {
      vpc: vpc,
    });
    //instanceSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH from anywhere');

    const rdsSg = new ec2.SecurityGroup(this, 'Aurora RDS SG', {
      vpc: vpc,
    });
    rdsSg.addIngressRule(ec2.Peer.securityGroupId(instanceSg.securityGroupId), ec2.Port.tcp(3306), 'All Mysql clinet connect');
    const mskSg = new ec2.SecurityGroup(this, 'MSK SG', {
      vpc: vpc,
    });
    
    const dmsSg = new ec2.SecurityGroup(this, 'DMS SG', {
      vpc: vpc,
    });

    rdsSg.addIngressRule(ec2.Peer.securityGroupId(dmsSg.securityGroupId), ec2.Port.tcp(3306), 'All DMS connect');
    mskSg.addIngressRule(ec2.Peer.securityGroupId(dmsSg.securityGroupId), ec2.Port.tcp(9092), 'All DMS connect to Kafka plaintext');
    mskSg.addIngressRule(ec2.Peer.securityGroupId(dmsSg.securityGroupId), ec2.Port.tcp(2181), 'All DMS connect to zookeeper');
    
    const rdsPG = new rds.ParameterGroup(this, 'Aurora MySLQ Binlog', {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.of('2.11.1'),
      }),
      parameters: {
        binlog_format: 'ROW',
        binlog_checksum: 'NONE',
        binlog_row_image: 'FULL',
      }
    });
    const rdsCluster = new rds.DatabaseCluster(this, 'MySQL 2.11.1', {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version:rds.AuroraMysqlEngineVersion.VER_2_11_1
      }),
      credentials: rds.Credentials.fromPassword('admin', cdk.SecretValue.unsafePlainText('Welcome#123456')),
      instanceProps: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.MEMORY5, ec2.InstanceSize.XLARGE2),
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        vpc: vpc,
        securityGroups: [rdsSg],
      },
      cloudwatchLogsExports: ['audit', 'error', 'general', 'slowquery'],
      parameterGroup: rdsPG,
    });

    const userData = ec2.UserData.forLinux();
    userData.addCommands('yum update -y', 
    'yum install mysql -y',
    'amazon-linux-extras install epel -y',
    'yum install sysbench -y',
    `while ! mysql -h ${rdsCluster.clusterEndpoint.hostname} -uadmin -pWelcome#123456 -e "SELECT 1"; do
    echo "Waiting for Aurora MySQL to be ready..."
    sleep 5
    done`,
    'echo "Waiting more 3 min...."',
    'sleep 180',
    `mysql -uadmin -pWelcome#123456 -h${rdsCluster.clusterEndpoint.hostname} -e "create database sbtest;"`,
    `sysbench oltp_read_only --mysql-host=${rdsCluster.clusterEndpoint.hostname} \
    --mysql-user=admin --mysql-password=Welcome#123456 \
    --mysql-port=3306 --mysql-db=sbtest --threads=40 \
    --tables=40 --table-size=2000000 prepare`);

    const role = new iam.Role(this, 'MyEC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    const ec2Instance = new ec2.Instance(this, 'MySQL Cliet Instance', {
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      role: role,
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      userData: userData,
      securityGroup: instanceSg,
    });

    const mskConfig = new mskCfn.CfnConfiguration(this, 'MSK Configuration', {
      name: 'my-msk-configuration',
      serverProperties: `
auto.create.topics.enable=true
default.replication.factor=1
min.insync.replicas=1
num.io.threads=8
num.network.threads=5
num.partitions=1
num.replica.fetchers=2
replica.lag.time.max.ms=30000
socket.receive.buffer.bytes=102400
socket.request.max.bytes=104857600
socket.send.buffer.bytes=102400
unclean.leader.election.enable=true
zookeeper.session.timeout.ms=18000
      `
    });
    const mskCluster = new msk.Cluster(this, 'MSK Cluter', {
      clusterName: 'binlog-msk-cluster',
      kafkaVersion: msk.KafkaVersion.V2_8_1,
      vpc: vpc,
      encryptionInTransit: {
        clientBroker: msk.ClientBrokerEncryption.PLAINTEXT
      },
      configurationInfo: {
        arn: mskConfig.attrArn,
        revision: 1
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      securityGroups: [mskSg],
    });

    mskCluster.connections.addSecurityGroup(mskSg);
    mskCluster.node.addDependency(mskConfig);

    const mskVpcRole = new iam.Role(this, 'DMS VPC Role', {
      assumedBy: new iam.ServicePrincipal('dms.amazonaws.com'),
      roleName: 'dms-vpc-role'
    });

    mskVpcRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonDMSVPCManagementRole'));

    const dmsRepSubnets = new dms.CfnReplicationSubnetGroup(this, 'DMS Replica Subnet Group', {
      replicationSubnetGroupDescription: 'DMS Replica Subnet Group',
      subnetIds: vpc.privateSubnets.map(subnet => subnet.subnetId),
    });

    dmsRepSubnets.node.addDependency(mskVpcRole);

    const dmsInstace = new dms.CfnReplicationInstance(this, 'MySQL DMS Instance',{
      replicationInstanceClass: 'dms.c6i.2xlarge',
      engineVersion: '3.4.7',
      publiclyAccessible: false,
      multiAz: false,
      allocatedStorage: 20,
      autoMinorVersionUpgrade: true,
      vpcSecurityGroupIds: [dmsSg.securityGroupId],
      replicationSubnetGroupIdentifier: dmsRepSubnets.ref,
    });

    const rdsEndpoint = new dms.CfnEndpoint(this, 'MySQL DMS Endpoint', {
      endpointType: 'source',
      engineName: 'aurora',
      username: 'admin',
      password: 'Welcome#123456',
      serverName: rdsCluster.clusterEndpoint.hostname,
      port: rdsCluster.clusterReadEndpoint.port,
    });

    const mskEndpoint = new dms.CfnEndpoint(this, 'MSK DMS Endpoint', {
      endpointType: 'target',
      engineName: 'kafka',
      kafkaSettings: {
        broker: mskCluster.bootstrapBrokers,
      },
    });

    for (var i = 1; i < 41; i++){
      new dms.CfnReplicationTask(this, `MySQL Replica Task ${i}`, {
        replicationInstanceArn: dmsInstace.ref,
        sourceEndpointArn: rdsEndpoint.ref,
        targetEndpointArn: mskEndpoint.ref,
        replicationTaskSettings: JSON.stringify({
          FullLoadSettings: {
            TargetTablePrepMode: 'DO_NOTHING'
          }
        }),
        replicationTaskIdentifier: `a${i}`,
        migrationType: 'full-load-and-cdc',
        tableMappings: `
          {"rules": 
            [{"rule-type": "selection",
              "rule-id": "167487852",
              "rule-name": "167487852",
              "object-locator": {
                "schema-name": "sbtest",
                "table-name": "sbtest${i}"
              },
              "rule-action": "include",
              "filters": []
            }]
          }`,
        tags: [{
          key: 'Name',
          value: `MySQLDMSReplicationTask-${i}`
        }]
      });
    }

    new cw.Alarm(this, 'RdsCpuAlarm', {
      metric: rdsCluster.metricCPUUtilization(),
      threshold: 40,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'RDS Cluster CPU utilization is above 40%',
      alarmName: 'RdsCpuAlarm',
    });

  }
}
