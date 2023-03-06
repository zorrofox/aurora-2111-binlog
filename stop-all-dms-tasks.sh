#! /bin/bash

arn=$(aws dms describe-replication-tasks \
    --query 'ReplicationTasks[].ReplicationTaskArn' \
    --output text)

for a in $arn
do
    aws dms stop-replication-task \
        --replication-task-arn $a
done