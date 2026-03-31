provider "oci" {}

resource "oci_core_instance" "generated_oci_core_instance" {
	agent_config {
		is_management_disabled = "false"
		is_monitoring_disabled = "false"
		plugins_config {
			desired_state = "DISABLED"
			name = "WebLogic Management Service"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Vulnerability Scanning"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Oracle Java Management Service"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "OS Management Hub Agent"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Management Agent"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Fleet Application Management Service"
		}
		plugins_config {
			desired_state = "ENABLED"
			name = "Custom Logs Monitoring"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Compute RDMA GPU Monitoring"
		}
		plugins_config {
			desired_state = "ENABLED"
			name = "Compute Instance Run Command"
		}
		plugins_config {
			desired_state = "ENABLED"
			name = "Compute Instance Monitoring"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Compute HPC RDMA Auto-Configuration"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Compute HPC RDMA Authentication"
		}
		plugins_config {
			desired_state = "ENABLED"
			name = "Cloud Guard Workload Protection"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Block Volume Management"
		}
		plugins_config {
			desired_state = "DISABLED"
			name = "Bastion"
		}
	}
	availability_config {
		recovery_action = "RESTORE_INSTANCE"
	}
	availability_domain = "uEmW:AP-SINGAPORE-1-AD-1"
	compartment_id = "ocid1.tenancy.oc1..aaaaaaaaaf455u7fynhpyl3xfqccqv2yz3v43hwkntmorxignpsxhtm55kma"
	create_vnic_details {
		assign_ipv6ip = "false"
		assign_private_dns_record = "true"
		assign_public_ip = "false"
		subnet_id = "ocid1.subnet.oc1.ap-singapore-1.aaaaaaaap3nxz2d6mi2k624rngchgksgkiznowxr2coizg5zlapbgecinqlq"
	}
	display_name = "instance-20260331-1547"
	instance_options {
		are_legacy_imds_endpoints_disabled = "false"
	}
	is_pv_encryption_in_transit_enabled = "true"
	metadata = {
		"ssh_authorized_keys" = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDWevcjaI0athyfcWTku83pCokYtmx9ZPz+r4GyCyaEAnt5puVaBccM2wPJJ2TmhO9EnWjdenB09TV+zy+u2FYaYrHfZdyF/zIUrynli/6OblXRdWp0zAY7HiVnMzixdsZuBJC8OlJ1/ks+nmXawnmfx1EImY/IzKAKMeYmLqCY8Du3ynyw2AhS9TTrZMYarOj+Y6Gq1ESQX2XvTqRQEr8qu8GHrE1DKWT7HQ2MBIv2RYIOTV4KL63T0g8rHD45K9GQqo8b69q5GODeISR0XfIk7ITFVXZD/rlUI5RHM/FNJfyh0TZjJmihz7aLKAHWOVFjzVQx6RXkU7VyuzUnu/jj ssh-key-2026-03-31"
	}
	shape = "VM.Standard.A1.Flex"
	shape_config {
		memory_in_gbs = "12"
		ocpus = "2"
	}
	source_details {
		source_id = "ocid1.image.oc1.ap-singapore-1.aaaaaaaafa5ym7zga7cbi5sgagpc6kkwjdsst3vccqxxi4bm7rrvgz4o7wba"
		source_type = "image"
	}
}

resource "oci_core_vcn" "generated_oci_core_vcn" {
	cidr_block = "10.0.0.0/16"
	compartment_id = "ocid1.tenancy.oc1..aaaaaaaaaf455u7fynhpyl3xfqccqv2yz3v43hwkntmorxignpsxhtm55kma"
	display_name = "vcn-20260331-1547"
	dns_label = "vcn03311548"
}

resource "oci_core_subnet" "generated_oci_core_subnet" {
	cidr_block = "10.0.0.0/24"
	compartment_id = "ocid1.tenancy.oc1..aaaaaaaaaf455u7fynhpyl3xfqccqv2yz3v43hwkntmorxignpsxhtm55kma"
	display_name = "subnet-20260331-1547"
	dns_label = "subnet03311548"
	route_table_id = "${oci_core_vcn.generated_oci_core_vcn.default_route_table_id}"
	vcn_id = "${oci_core_vcn.generated_oci_core_vcn.id}"
}

resource "oci_core_internet_gateway" "generated_oci_core_internet_gateway" {
	compartment_id = "ocid1.tenancy.oc1..aaaaaaaaaf455u7fynhpyl3xfqccqv2yz3v43hwkntmorxignpsxhtm55kma"
	display_name = "Internet Gateway vcn-20260331-1547"
	enabled = "true"
	vcn_id = "${oci_core_vcn.generated_oci_core_vcn.id}"
}

resource "oci_core_default_route_table" "generated_oci_core_default_route_table" {
	route_rules {
		destination = "0.0.0.0/0"
		destination_type = "CIDR_BLOCK"
		network_entity_id = "${oci_core_internet_gateway.generated_oci_core_internet_gateway.id}"
	}
	manage_default_resource_id = "${oci_core_vcn.generated_oci_core_vcn.default_route_table_id}"
}
