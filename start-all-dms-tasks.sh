#! /bin/bash

arn=$(aws dms describe-replication-tasks \
    --query 'ReplicationTasks[].ReplicationTaskArn' \
    --output text)

for a in $arn
do
    aws dms start-replication-task \
        --replication-task-arn $a \
        --start-replication-task-type start-replication
done